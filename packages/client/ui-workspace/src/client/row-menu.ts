/**
 * Workspace row menu registry: the one extension point that lets any plugin add
 * an entry to a real Workspace row's "…" menu.
 *
 * The contribution currency is JSON-compatible data plus one callback — never a
 * ReactNode. A row menu entry is a verb the operator can invoke on a Workspace,
 * and keeping it data is what lets a feature plugin contribute without importing
 * ui-workspace's components (the Slot rule for cross-plugin UI does not apply
 * here: this is a list of verbs, not a rendering position).
 *
 * `ui-workspace` owns and provides the service because it renders the row. Every
 * registration is an effect of the caller's fiber, so unloading a contributor
 * removes exactly its entries.
 *
 * @module @deepseek-ai/dsh-client-ui-workspace/client
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * One contributed row-menu entry.
 *
 * `label` is already localized by the contributor (bind its own namespace with
 * `ctx.locale.bind(ns)`): the dictionary stays with the copy that owns it, and
 * ui-workspace never learns another package's strings.
 */
export interface WorkspaceRowMenuContribution {
  /** Stable identity of this entry, unique per Workspace row menu. */
  id: string
  /** Localized row text, bound by the contributor before it registers. */
  label: string
  /**
   * Placement within the contributed block: lower values come first. Entries
   * with equal order keep registration order. The block always renders between
   * Rename and the destructive Delete, which stays last whatever the order.
   */
  order?: number
  /** Render as a destructive row (error-colored text and danger hover fill). */
  danger?: boolean
  /**
   * Invoke this entry for one Workspace. The row closes the menu before calling,
   * so the handler owns whatever surface it opens.
   * @param workspace - the Workspace whose row was used.
   */
  onSelect: (workspace: WorkspaceView) => void
}

/**
 * The Workspace row menu registry (`ctx.workspaceRowMenu`).
 *
 * `entries` is the observable projection the browsing region renders: it is
 * stable between changes and republished on every registration change, so a
 * surface that reads it through the inject `hooks` compartment re-renders when a
 * plugin is loaded or unloaded.
 */
export interface WorkspaceRowMenu {
  /**
   * Contribute one entry to every real Workspace row menu.
   * @param contribution - the entry to add.
   * @returns a disposer that removes it; also registered as the caller's effect.
   */
  register(contribution: WorkspaceRowMenuContribution): () => void
  /**
   * The current entries in the order the row renders them.
   * @returns a snapshot that changes identity only when the entry set moves.
   */
  entries(): readonly WorkspaceRowMenuContribution[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Workspace row menu extension point, owned by ui-workspace. */
    workspaceRowMenu: WorkspaceRowMenu
  }
}

/** Registry plus the observable face the browsing region binds to a hook. */
export class WorkspaceRowMenuService extends Service implements WorkspaceRowMenu {
  /** Live contributions keyed by id, so a re-registration replaces in place. */
  private readonly contributions = new Map<string, WorkspaceRowMenuContribution>()
  /** Monotonic registration counter, the tiebreak for equal `order`. */
  private readonly sequence = new Map<string, number>()
  private counter = 0
  private listeners = new Set<() => void>()
  /**
   * Published snapshot. `getSnapshot` must return the same reference until the
   * fact moves, which is why the sorted array is rebuilt only on a change.
   */
  private published: readonly WorkspaceRowMenuContribution[] = []

  /** Hostable observable face of {@link entries} for the inject `hooks` compartment. */
  readonly source: HostObservable<readonly WorkspaceRowMenuContribution[]> = {
    getSnapshot: () => this.published,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /** @param ctx - Client root Context. */
  constructor(ctx: Context) {
    super(ctx, 'workspaceRowMenu')
  }

  /**
   * Contribute one entry.
   * @param contribution - the entry to add.
   * @returns a disposer that removes it.
   */
  register(contribution: WorkspaceRowMenuContribution): () => void {
    this.contributions.set(contribution.id, contribution)
    this.counter += 1
    this.sequence.set(contribution.id, this.counter)
    this.publish()
    return () => {
      // A later registration may have replaced this id; disposing this one must
      // not drop its successor's entry.
      if (this.contributions.get(contribution.id) !== contribution) return
      this.contributions.delete(contribution.id)
      this.sequence.delete(contribution.id)
      this.publish()
    }
  }

  /**
   * The current entries in render order.
   * @returns the published snapshot.
   */
  entries(): readonly WorkspaceRowMenuContribution[] {
    return this.published
  }

  /** Rebuild the published snapshot and notify subscribers (one step, per the published-value rule). */
  private publish(): void {
    this.published = [...this.contributions.values()].sort((left, right) => {
      const byOrder = (left.order ?? 0) - (right.order ?? 0)
      if (byOrder !== 0) return byOrder
      return (this.sequence.get(left.id) ?? 0) - (this.sequence.get(right.id) ?? 0)
    })
    for (const listener of this.listeners) listener()
  }
}
