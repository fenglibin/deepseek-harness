/**
 * Staged store over the `mcp` settings namespace. Every mutation — edit, toggle,
 * and remove — writes the user-editable `mcp.json` through a Host single-server
 * update, so the manual-edit source stays the authority and the settings mirror
 * only ever refreshes from it. The section reads the mirror through the bound
 * scope and never mutates the namespace directly.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge (the `mcp` Remote namespace) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { McpServerEntry, McpSettings } from './types.ts'

/** State rendered by the MCP servers section. */
export interface McpState {
  /** Whether the namespace answered a section this page may edit. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** The stored server list in order. */
  servers: readonly McpServerEntry[]
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last write failed or was refused. */
  failed: boolean
}

/** Bridging one settings scope onto the server-list operations the section invokes. */
export class McpStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<McpState>

  private saving = false
  private failed = false
  private saveGeneration = 0
  private readonly unsubscribe: () => void

  /**
   * @param ctx - the page plugin's context, whose `remote.mcp` writes the
   * user-editable `mcp.json` for single-server edits, toggles, and removals.
   * @param scope - bound `mcp` settings scope, read-only from this store.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly scope: SettingsScope<McpSettings>,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /** The stored server list, empty while the namespace has not answered. */
  servers(): readonly McpServerEntry[] {
    return this.scope.getSnapshot().value?.servers ?? []
  }

  /** Whether a server with this name is already in the list. */
  has(serverName: string): boolean {
    return this.servers().some(server => server.serverName === serverName)
  }

  /**
   * Remove one server by name (idempotent when already absent). The Host drops
   * the entry from `mcp.json` and immediately syncs, so the mirror — and the
   * mounted client — both lose the server in the same step.
   * @param serverName - the entry to remove.
   * @returns whether the write landed and synced.
   */
  remove(serverName: string): Promise<boolean> {
    if (!this.has(serverName)) return Promise.resolve(true)
    return this.writeMcpServer(() => this.ctx.remote.mcp.removeMcpServer(serverName))
  }

  /**
   * Replace one server's entry in place. Like toggle and remove, an edit writes
   * the user-editable `mcp.json` (through the Host's single-server update)
   * rather than the settings namespace, so the document that is the manual-edit
   * source stays the authority and the change applies immediately.
   * @param server - the entry, keyed by its `serverName`.
   * @returns whether the write landed and synced.
   */
  async update(server: McpServerEntry): Promise<boolean> {
    if (!this.has(server.serverName)) return Promise.resolve(false)
    return this.writeMcpServer(() => this.ctx.remote.mcp.updateMcpServer(server))
  }

  /**
   * Flip one server's `enabled` flag. Like an edit, a toggle writes the
   * user-editable `mcp.json` (through the Host's single-server update) rather
   * than the settings namespace, so the enabled state and the manual-edit
   * source never drift.
   * @param serverName - the entry to toggle.
   * @param enabled - the target enabled state.
   * @returns whether the write landed (already in the target state counts as landed).
   */
  setEnabled(serverName: string, enabled: boolean): Promise<boolean> {
    const current = this.servers().find(server => server.serverName === serverName)
    if (current === undefined || current.enabled === enabled) return Promise.resolve(true)
    return this.update({ ...current, enabled })
  }

  /** Stop observing the scope and suppress late write settlements. */
  dispose(): void {
    this.saveGeneration += 1
    this.unsubscribe()
  }

  /**
   * Run one Host `mcp.json` single-server write and settle the shared
   * saving/failed flags. A read that has not answered yet, a read-only
   * document, or a write still in flight refuses rather than clobbering.
   * @param action - the Remote write to invoke.
   * @returns whether the write landed and synced.
   */
  private async writeMcpServer(action: () => Promise<{ ok: boolean }>): Promise<boolean> {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable || this.saving) return false
    const generation = ++this.saveGeneration
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const result = await action()
      if (generation !== this.saveGeneration) return false
      this.saving = false
      this.failed = !result.ok
      this.publish()
      // The Host sync pushes `settings/document-updated`, which refreshes the
      // mirror and this store's server list through the existing subscription.
      return result.ok
    } catch {
      if (generation !== this.saveGeneration) return false
      this.saving = false
      this.failed = true
      this.publish()
      return false
    }
  }

  private projection(): McpState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      servers: this.servers(),
      saving: this.saving,
      failed: this.failed,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
