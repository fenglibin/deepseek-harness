/**
 * State owner for the MCP section's `mcp.json` editor: it reads and writes the
 * user-editable document that sits beside the settings document. The Host
 * manager seeds a missing document on first read, so availability is just the
 * loopback fact — a remote deployment has no local document to sit beside.
 * Every write is validated and synced by the Host before it reports success,
 * so a refused or malformed document never reaches settings.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Browser state of the `mcp.json` document the MCP section edits in place. */
export interface McpDocumentState {
  /** Whether the editor is available; non-loopback deployments have no local document. */
  status: 'idle' | 'ready' | 'unavailable'
  /** Whether a read or write is crossing the wire. */
  opening: boolean
  /** Last read/write diagnostic; UI exposes only localized copy. */
  error: string | null
  /** The current document text, empty until a read lands. */
  text: string
}

/** Reads and writes the Host-owned `mcp.json` in place. */
export class McpDocumentStore {
  /** uSES-safe state source shared by the `mcp.json` editor. */
  readonly store: SnapshotStore<McpDocumentState> = createSnapshotStore({
    status: 'idle', opening: false, error: null, text: '',
  })

  /**
   * @param ctx - the plugin's context, whose `remote.mcp` reads/writes the
   * document and whose `$host` tells whether a local document can exist.
   */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Resolve availability from the loopback fact. The text itself is pulled on
   * demand by {@link read}, so opening the editor always starts from the latest
   * document rather than whatever a section mount happened to load.
   * @returns settlement after the availability check.
   */
  load(): Promise<void> {
    const available = this.ctx.remote.$host.isLoopback
    this.store.update((state) => {
      state.status = available ? 'ready' : 'unavailable'
      state.error = null
    })
    return Promise.resolve()
  }

  /**
   * Pull the current document text once. A call while one is in flight is a
   * no-op, so concurrent open gestures never stack wire reads.
   * @returns settlement after the read.
   */
  async read(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.status !== 'ready' || current.opening) return
    this.store.update((state) => {
      state.opening = true
      state.error = null
    })
    try {
      const result = await this.ctx.remote.mcp.readMcpDocument()
      if (result.ok) {
        this.store.update((state) => { state.text = result.value.text })
      } else {
        this.store.update((state) => { state.error = result.error.message })
      }
    } finally {
      this.store.update((state) => { state.opening = false })
    }
  }

  /**
   * Write one document text and sync it. The Host validates the JSON and the
   * `mcpServers` structure before persisting, so an invalid document is
   * refused and reported here rather than written.
   * @param text - the candidate `mcp.json` text.
   * @returns whether the write landed and synced.
   */
  async write(text: string): Promise<boolean> {
    if (this.store.getSnapshot().opening) return false
    this.store.update((state) => {
      state.opening = true
      state.error = null
    })
    try {
      const result = await this.ctx.remote.mcp.writeMcpDocument(text)
      if (!result.ok) {
        this.store.update((state) => { state.error = result.error.message })
        return false
      }
      this.store.update((state) => { state.text = text })
      return true
    } finally {
      this.store.update((state) => { state.opening = false })
    }
  }

  /** No subscriptions to release; retained for symmetry with the section lifecycle. */
  dispose(): void {}
}
