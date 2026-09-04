/**
 * Live-status store over the Host `mcp` Remote namespace. It pulls the
 * manager's per-server connection state and tool names once on demand and
 * again after a refresh, and exposes a `refresh` that forces one server to
 * reconnect. The settings list stays the source of truth for which servers
 * exist; this store only overlays the runtime status the Host reports.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { McpServerStatusView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** State rendered beside the server list. */
export interface McpStatusState {
  /** Per-server status by serverName. */
  statuses: ReadonlyMap<string, McpServerStatusView>
  /** Whether a status pull is crossing the wire. */
  loading: boolean
  /** Whether a refresh is crossing the wire. */
  refreshing: boolean
}

/** Bridges the Host `mcp` Remote namespace onto the status the section renders. */
export class McpStatusStore {
  /** The snapshot the section renders from. */
  readonly store: SnapshotStore<McpStatusState>

  private statuses = new Map<string, McpServerStatusView>()
  private loading = false
  private refreshing = false
  private loadGeneration = 0
  /** Set when a pushed event lands during an in-flight pull, forcing one more. */
  private reloadRequested = false
  /** Cancels the pushed-status subscription; released on dispose. */
  private readonly unsubscribeStatus: () => void

  /**
   * @param ctx - the page plugin's context, whose `remote.mcp` answers the manager.
   */
  constructor(private readonly ctx: ClientContext) {
    this.store = createSnapshotStore(this.projection())
    // The manager pushes `mcp/status` on every transition; re-pull so a
    // freshly mounted server's connected state appears without polling.
    this.unsubscribeStatus = ctx.remote.$on('mcp/status', () => { void this.load() })
  }

  /**
   * Pull the manager's live status once. A call while one is in flight is free,
   * so a background invalidation never stacks wire calls.
   * @returns settlement after the pull.
   */
  async load(): Promise<void> {
    if (this.loading) {
      // A pushed event landed while a pull is crossing the wire; remember it
      // so the in-flight pull is followed by one that sees the newer state.
      this.reloadRequested = true
      return
    }
    const generation = ++this.loadGeneration
    this.loading = true
    this.publish()
    try {
      const response = await this.ctx.remote.mcp.list()
      if (generation === this.loadGeneration && response.ok) {
        this.statuses = new Map(response.value.map(view => [view.serverName, view]))
      }
    } finally {
      this.loading = false
      this.publish()
    }
    if (this.reloadRequested) {
      this.reloadRequested = false
      void this.load()
    }
  }

  /**
   * Force one server to reconnect, then re-pull the status list. A refresh
   * already in flight is a no-op.
   * @param serverName - the entry to reconnect.
   * @returns settlement after the refresh and re-pull.
   */
  async refresh(serverName: string): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    this.publish()
    await this.ctx.remote.mcp.refresh(serverName)
    this.refreshing = false
    await this.load()
  }

  /** The last reported status for one server, or undefined while unobserved. */
  statusOf(serverName: string): McpServerStatusView | undefined {
    return this.statuses.get(serverName)
  }

  /** Suppress late load settlements and drop the pushed-status subscription. */
  dispose(): void {
    this.loadGeneration += 1
    this.unsubscribeStatus()
  }

  private projection(): McpStatusState {
    return {
      statuses: this.statuses,
      loading: this.loading,
      refreshing: this.refreshing,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
