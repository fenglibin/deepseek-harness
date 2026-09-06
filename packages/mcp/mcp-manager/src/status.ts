/**
 * Client-safe wire vocabulary for the MCP manager's `mcp` Remote namespace.
 * Pure types only: nothing here imports a Host-only symbol, so the generated
 * Remote client face and a configuration surface can name what `list` returns
 * without reaching a Host package.
 */

/** Connection lifecycle a mounted server reports, plus `unknown` for an unobserved one. */
export type McpServerStatusKind = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'unknown'

/** One server's live status as the manager's `list` Remote method returns it. */
export interface McpServerStatusView {
  /** Stable local namespace for this server's model-facing tools. */
  serverName: string
  /** Latest lifecycle state the supervisor reported, or `unknown` while unobserved. */
  status: McpServerStatusKind
  /** Model-facing tool names this server currently registers (`mcp__<serverName>__…`). */
  tools: string[]
  /** Diagnostic text from the latest failure, when one was reported. */
  error?: string
}

/** Confirmation that the `mcp.json` document was handed to the native editor. */
export interface McpDocumentOpenValue {
  readonly opened: true
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One server's live connection status changed. Payload-free: a
     * configuration surface re-reads the manager's `list` Remote method for
     * the new state.
     * @mode emit
     */
    'mcp/status'(): void
  }
}
