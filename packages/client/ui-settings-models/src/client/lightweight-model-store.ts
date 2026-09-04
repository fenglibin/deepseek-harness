/**
 * Lightweight-model preference: one provider/model route picked from the live
 * model catalog and stored in its own settings namespace. The catalog supplies
 * the choices, and a stored route the catalog no longer advertises stays
 * listed so the user can still drop it. A browser whose settings scope runs in
 * memory mode never writes, so the card renders read-only instead of claiming
 * a save that the Host document will not hold.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Namespace of the Host-owned lightweight-model preference. */
export const LIGHTWEIGHT_MODEL_SETTINGS_NS = 'lightweight-model'

/** Stored route; both fields empty means the user chose no lightweight model. */
export interface LightweightModelSettings {
  /** Registered provider route, empty when unset. */
  provider: string
  /** Provider-owned model id, empty when unset. */
  model: string
}

/** One exact provider/model route. */
export interface LightweightModelRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** One selectable route joined with the display names the catalog reports. */
export interface LightweightModelCandidate extends LightweightModelRoute {
  /** Stable opaque identity used only for lookup. */
  key: string
  /** Adapter-owned provider display name. */
  providerName: string
  /** Adapter-owned model display name. */
  modelName: string
}

/** State rendered by the lightweight-model card. */
export interface LightweightModelState {
  /** Whether the namespace answered a section this card may edit. */
  available: boolean
  /** Whether the Host document accepts writes; memory mode never does. */
  writable: boolean
  /** Catalog rows, with a stored or staged route the catalog dropped retained. */
  candidates: readonly LightweightModelCandidate[]
  /** Opaque key of the route the draft selects, or undefined when none is. */
  selected: string | undefined
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save failed or was refused. */
  failed: boolean
  /** Whether the draft differs from the stored route. */
  dirty: boolean
  /** Model-catalog request state. */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
}

/** One staged choice: an exact route, or the explicit absence of one. */
type LightweightModelDraft =
  | { readonly kind: 'route'; readonly route: LightweightModelRoute }
  | { readonly kind: 'unset' }

/**
 * Stable identity for one exact route; callers resolve it by lookup and never parse it.
 * @param route - provider/model route to identify.
 * @returns opaque key for lookup within the card.
 */
export function lightweightModelKey(route: LightweightModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Flatten the model catalog into selectable rows, keeping the routes it no
 * longer advertises so a stored choice stays visible and removable.
 * @param groups - current model catalog grouped by provider.
 * @param retained - routes to keep selectable when absent from the catalog.
 * @returns candidate rows in catalog order, retained leftovers last.
 */
export function lightweightModelCandidates(
  groups: readonly ModelProviderGroup[],
  retained: readonly LightweightModelRoute[],
): LightweightModelCandidate[] {
  const pending = new Map(retained.map(route => [lightweightModelKey(route), route]))
  const candidates = groups.flatMap(group => group.models.map((model): LightweightModelCandidate => {
    const route: LightweightModelRoute = { provider: group.id, model: model.id }
    const key = lightweightModelKey(route)
    pending.delete(key)
    return { ...route, key, providerName: group.name, modelName: model.name }
  }))
  for (const route of pending.values()) {
    const key = lightweightModelKey(route)
    candidates.push({ ...route, key, providerName: route.provider, modelName: route.model })
  }
  return candidates
}

/** Bridges one settings scope and the live model catalog onto a staged card. */
export class LightweightModelStore {
  /** The snapshot the card renders from (uSES-safe store). */
  readonly store: SnapshotStore<LightweightModelState>

  private groups: readonly ModelProviderGroup[] = []
  private catalogStatus: LightweightModelState['catalogStatus'] = 'idle'
  private draft: LightweightModelDraft | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private disposed = false
  private saveGeneration = 0
  private catalogGeneration = 0
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `lightweight-model` settings scope.
   * @param ctx - the page plugin's context, whose `remote.session` namespace
   * answers the Host model catalog.
   */
  constructor(
    private readonly scope: SettingsScope<LightweightModelSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /**
   * Load the model catalog once. A call made while one is already in flight or
   * already answered is free; an error stands until {@link retry}.
   * @returns settlement after the catalog request, or immediately when this
   * store need not request one.
   */
  load(): Promise<void> {
    if (this.catalogStatus !== 'idle') return Promise.resolve()
    return this.requestCatalog()
  }

  /** Request the model catalog again, after a failure or a stale answer. */
  retry(): void {
    if (this.catalogStatus === 'loading') return
    void this.requestCatalog()
  }

  /**
   * Reload the model catalog after a Host model input changed. A card that has
   * never requested one — an unopened Models page — stays unfetched, so a
   * background invalidation never makes the page reach the wire.
   */
  refresh(): void {
    if (this.catalogStatus === 'idle') return
    void this.requestCatalog()
  }

  /**
   * Stage one catalog route as the draft choice. An unknown key, a scope the
   * Host will not write, and a save already crossing the wire are all ignored.
   * @param key - opaque candidate key reported by {@link store}.
   */
  select(key: string): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    const candidate = this.candidates().find(row => row.key === key)
    if (candidate === undefined) return
    this.beginDraft()
    this.draft = { kind: 'route', route: { provider: candidate.provider, model: candidate.model } }
    this.failed = false
    this.publish()
  }

  /**
   * Stage the absence of a route, so auxiliary calls follow the
   * conversation's own model again. Shares {@link select}'s guards.
   */
  clear(): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    this.beginDraft()
    this.draft = { kind: 'unset' }
    this.failed = false
    this.publish()
  }

  /**
   * Persist the draft as one revision-fenced mutation over both stored fields.
   * A revision that moved on since the draft began is refused rather than
   * clobbering the newer answer, and a write the Host did not land is reported
   * as a failure instead of folded into the snapshot.
   * @returns nothing; {@link store} carries success or failure.
   */
  async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    const draft = this.draft
    if (draft === undefined || this.selectedKey() === this.storedKey()) return
    if (snapshot.revision !== this.draftRevision) {
      this.failed = true
      this.publish()
      return
    }
    const generation = ++this.saveGeneration
    const route = draft.kind === 'route' ? draft.route : { provider: '', model: '' }
    this.saving = true
    this.failed = false
    this.publish()
    await this.scope.mutate([
      { op: 'set', path: ['provider'], value: route.provider },
      { op: 'set', path: ['model'], value: route.model },
    ], this.draftRevision)
    if (generation !== this.saveGeneration) return
    const landed = this.selectedKey() === this.storedKey()
    this.saving = false
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
  }

  /** Drop the staged choice; the stored route stands again. */
  discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  /** Stop observing the scope and suppress late catalog and write settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  private async requestCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.publish()
    const response = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.catalogGeneration) return
    if (response.ok) {
      this.groups = response.value.groups
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private beginDraft(): void {
    if (this.draft !== undefined) return
    this.draftRevision = this.scope.getSnapshot().revision
  }

  private clearDraft(): void {
    this.draft = undefined
    this.draftRevision = undefined
    this.failed = false
  }

  /** Routes the catalog must keep selectable: the stored one and the staged one. */
  private retained(): LightweightModelRoute[] {
    const routes: LightweightModelRoute[] = []
    const stored = this.storedRoute()
    if (stored.provider !== '') routes.push(stored)
    if (this.draft?.kind === 'route') routes.push(this.draft.route)
    return routes
  }

  private candidates(): readonly LightweightModelCandidate[] {
    return lightweightModelCandidates(this.groups, this.retained())
  }

  private storedRoute(): LightweightModelRoute {
    const value = this.scope.getSnapshot().value
    if (value === undefined) return { provider: '', model: '' }
    return { provider: value.provider, model: value.model }
  }

  private storedKey(): string | undefined {
    const route = this.storedRoute()
    return route.provider === '' ? undefined : lightweightModelKey(route)
  }

  private selectedKey(): string | undefined {
    const draft = this.draft
    if (draft === undefined) return this.storedKey()
    return draft.kind === 'route' ? lightweightModelKey(draft.route) : undefined
  }

  private projection(): LightweightModelState {
    const snapshot = this.scope.getSnapshot()
    const stored = this.storedKey()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      candidates: this.candidates(),
      selected: this.selectedKey(),
      saving: this.saving,
      failed: this.failed,
      dirty: this.draft !== undefined && this.selectedKey() !== stored,
      catalogStatus: this.catalogStatus,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
