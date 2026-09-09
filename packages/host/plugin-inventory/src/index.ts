/** Read-only projection of the current Cordis Loader plugin entries. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
// Type-only: the optional agent-preset roster resolved through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent-presets'
import { TypertRemoteService, Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  AgentPresetPluginGroup,
  AgentPresetPluginRow,
  PluginDescribeResult,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
  PluginReadmeText,
} from './types.ts'
import { pluginDescription, pluginReadme, readmeBody } from './description.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  /**
   * Where a module name resolves from when no entry tree narrows it. Captured
   * rather than read per call because a Remote invocation rebinds `ctx` to the
   * caller's context, which need not carry a base URL of its own.
   */
  private readonly hostBase: string

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
    this.hostBase = ctx.baseUrl ?? import.meta.url
  }

  /**
   * Anchors one plugin module name may resolve from, most specific first: the
   * tree that loaded the entry, then this deployment's base, then this module.
   * @param treeBase - base URL of the entry tree owning the module, when known.
   * @returns deduplicated anchors in precedence order.
   */
  private anchorsFor(treeBase: string | undefined): string[] {
    return [...new Set([treeBase ?? this.hostBase, this.hostBase, import.meta.url])]
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   *
   * When an agent-preset roster is composed, the snapshot also carries each
   * preset's composition rows, because those rows — not the Loader's own
   * entries — are where a deployment that mounts the roster runs its
   * model-facing plugins.
   *
   * The listing carries no prose: a description and README name are resolved
   * on demand through {@link describe}, so a roster read never pays for a
   * package's README file.
   * @returns Current non-group Loader entries in Loader order, with per-preset
   * compositions when a roster is composed.
   */
  @Remote('list')
  async list(): Promise<PluginInventorySnapshot> {
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { entries }
    const agentPresets: AgentPresetPluginGroup[] = []
    for (const composition of await presets.compositionInventory()) {
      const rows: AgentPresetPluginRow[] = composition.rows.map(({ fiberState, ...row }) => ({
        ...row,
        fiberPhase: fiberState === undefined ? null : FIBER_PHASE[fiberState],
      }))
      agentPresets.push({ ...composition, rows })
    }
    return { entries, agentPresets }
  }

  /**
   * Read one plugin module's short description and README name on demand.
   *
   * The listing carries neither: a full roster's worth of prose is not
   * something every `list` call should pay for, so a reader that opens one
   * card pays for exactly that one card here. The README's body is still
   * fetched separately through {@link readme}.
   * @param moduleName - exact module specifier a Loader entry or composition row names.
   * @returns the description and README name, omitting either key when the
   * package publishes none.
   */
  @Remote('describe')
  async describe(moduleName: string): Promise<PluginDescribeResult> {
    const anchors = this.anchorsFor(undefined)
    const description = await pluginDescription(moduleName, anchors)
    const readme = await pluginReadme(moduleName, anchors)
    return {
      ...description === undefined ? {} : { description },
      ...readme === undefined ? {} : { readme: readme.name },
    }
  }

  /**
   * Read the whole README one plugin module's package ships.
   *
   * The document is fetched when a reader opens it, because a full roster's
   * worth of prose is not something every `list` call should pay for. The body
   * comes back with its frontmatter block removed — that block is what
   * supplied the description {@link describe} already showed.
   * @param moduleName - exact module specifier a Loader entry or composition row names.
   * @returns the README's name and body, or undefined when the module cannot be
   * resolved or its package ships no README.
   */
  @Remote('readme')
  async readme(moduleName: string): Promise<PluginReadmeText | undefined> {
    const found = await pluginReadme(moduleName, this.anchorsFor(undefined))
    return found === undefined ? undefined : { name: found.name, text: readmeBody(found.text) }
  }

  /**
   * Enable or disable one Loader entry in the running tree only.
   *
   * The write is the entry's own `disabled` option, so an entry inside a
   * disabled group stays disabled after being enabled here — the group's word
   * is the effective one, and the snapshot reports exactly that. The entry is
   * updated directly rather than through `loader.update`, which would persist
   * through the owning tree. The host composition's root file is a patch
   * target rewritten empty on every boot, so a write-back there would bake
   * every composed row into it (and re-serialize the whole tree on each
   * toggle) for a change the next boot discards anyway. An entry changed here
   * therefore reverts when the process restarts.
   * @param entryId - the entry to change, as {@link list} reported it.
   * @param enabled - whether the entry should run.
   * @throws {RemoteError} `plugin-inventory/entry-not-found` when the Loader
   * carries no such entry, or `plugin-inventory/entry-is-group` when the id
   * names a structural group.
   */
  @Remote('setEnabled')
  async setEnabled(entryId: PluginEntryId, enabled: boolean): Promise<void> {
    let entry: Entry
    try {
      entry = this.ctx.loader.resolve(entryId)
    } catch {
      // `resolve` throws a plain Error for every unresolvable id, so the
      // failure is translated here rather than reaching the wire untyped.
      throw new RemoteError(
        'plugin-inventory/entry-not-found',
        `plugin-inventory: no Loader entry ${JSON.stringify(entryId)}`,
        { entryId },
      )
    }
    if (entry.options.group === true) {
      throw new RemoteError(
        'plugin-inventory/entry-is-group',
        `plugin-inventory: entry ${JSON.stringify(entryId)} is a group and carries no enablement of its own`,
        { entryId },
      )
    }
    await entry.update({ disabled: !enabled }, false, true)
  }
}

export default PluginInventoryGateway
