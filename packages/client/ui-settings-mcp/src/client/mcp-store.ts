/**
 * Staged store over the `mcp` settings namespace. The server list is one array,
 * so every operation rewrites the whole list in a single revision-fenced
 * mutation; the `env`/`headers` values are ordinary (non-secret) fields, so a
 * wholesale write cannot drop a field the wire never returned. A write that
 * lands on a moved revision fails rather than clobbering the newer answer.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
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
   * @param scope - bound `mcp` settings scope.
   */
  constructor(private readonly scope: SettingsScope<McpSettings>) {
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
   * Append one server. A duplicate name is refused rather than written.
   * @param server - the entry to append.
   * @returns whether the write landed.
   */
  add(server: McpServerEntry): Promise<boolean> {
    if (this.has(server.serverName)) return Promise.resolve(false)
    return this.write([...this.servers(), server])
  }

  /**
   * Remove one server by name (idempotent when already absent).
   * @param serverName - the entry to remove.
   * @returns whether the write landed.
   */
  remove(serverName: string): Promise<boolean> {
    if (!this.has(serverName)) return Promise.resolve(true)
    return this.write(this.servers().filter(server => server.serverName !== serverName))
  }

  /**
   * Replace one server's entry in place.
   * @param server - the entry, keyed by its `serverName`.
   * @returns whether the write landed.
   */
  update(server: McpServerEntry): Promise<boolean> {
    if (!this.has(server.serverName)) return Promise.resolve(false)
    return this.write(this.servers().map(entry => entry.serverName === server.serverName ? server : entry))
  }

  /**
   * Flip one server's `enabled` flag.
   * @param serverName - the entry to toggle.
   * @param enabled - the target enabled state.
   * @returns whether the write landed (already in the target state counts as landed).
   */
  setEnabled(serverName: string, enabled: boolean): Promise<boolean> {
    const current = this.servers().find(server => server.serverName === serverName)
    if (current === undefined || current.enabled === enabled) return Promise.resolve(true)
    return this.write(this.servers().map(server => server.serverName === serverName ? { ...server, enabled } : server))
  }

  /** Stop observing the scope and suppress late write settlements. */
  dispose(): void {
    this.saveGeneration += 1
    this.unsubscribe()
  }

  /**
   * Write the whole server list as one revision-fenced mutation, then re-read
   * the section the Host accepted. A moved revision or a refused write reports
   * failure rather than predicting success.
   * @param servers - the desired server list.
   * @returns whether the stored list matches the desired length after the write.
   */
  private async write(servers: McpServerEntry[]): Promise<boolean> {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable || this.saving) return false
    const generation = ++this.saveGeneration
    this.saving = true
    this.failed = false
    this.publish()
    try {
      // The server entries are JSON-compatible interfaces; the cast records
      // only the wire's `JsonValue` bound, which a plain interface lacks the
      // index signature to satisfy structurally.
      await this.scope.mutate([{ op: 'set', path: ['servers'], value: servers as unknown as JsonValue }], snapshot.revision)
    } catch {
      if (generation !== this.saveGeneration) return false
      this.saving = false
      this.failed = true
      this.publish()
      return false
    }
    if (generation !== this.saveGeneration) return false
    this.saving = false
    const landed = this.servers().length === servers.length
    this.failed = !landed
    this.publish()
    return landed
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
