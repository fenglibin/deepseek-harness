/**
 * State owner for the MCP section's "configure" action: it opens the
 * user-editable `mcp.json` that sits beside the settings document. The Host
 * manager seeds a missing document on first open, so availability is just the
 * loopback fact — a remote deployment has no local document to sit beside.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Browser state of the `mcp.json` document the MCP section can open. */
export interface McpDocumentState {
  /** Whether the button is available; non-loopback deployments have no local document. */
  status: 'idle' | 'ready' | 'unavailable'
  /** Whether one native-open request is in flight. */
  opening: boolean
  /** Last native-open diagnostic; UI exposes only localized copy. */
  error: string | null
}

/** Opens the Host-owned `mcp.json` for manual editing. */
export class McpDocumentStore {
  /** uSES-safe state source shared by the "configure" action. */
  readonly store: SnapshotStore<McpDocumentState> = createSnapshotStore({
    status: 'idle', opening: false, error: null,
  })

  /**
   * @param ctx - the plugin's context, whose `remote.mcp` opens the document
   * and whose `$host` tells whether a local document can exist.
   */
  constructor(private readonly ctx: ClientContext) {}

  /** Resolve availability from the loopback fact; the document itself is seeded lazily by the Host. */
  load(): Promise<void> {
    this.store.update((state) => {
      state.status = this.ctx.remote.$host.isLoopback ? 'ready' : 'unavailable'
      state.error = null
    })
    return Promise.resolve()
  }

  /**
   * Open the document once; concurrent gestures collapse behind the in-flight action.
   * @returns after the native-open request settles, or immediately when unavailable/already opening.
   */
  async open(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.status !== 'ready' || current.opening) return
    this.store.update((state) => {
      state.opening = true
      state.error = null
    })
    try {
      const result = await this.ctx.remote.mcp.openMcpDocument()
      if (!result.ok) {
        this.store.update((state) => { state.error = result.error.message })
      }
    } finally {
      this.store.update((state) => { state.opening = false })
    }
  }

  /** No subscriptions to release; retained for symmetry with the section lifecycle. */
  dispose(): void {}
}
