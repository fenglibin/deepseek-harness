/**
 * Client-safe wire vocabulary for the MCP manager's `mcp` Remote namespace.
 * Pure types only: nothing here imports a Host-only symbol, so the generated
 * Remote client face and a configuration surface can name what `list` returns
 * without reaching a Host package.
 */

// Re-exported here so the `./types` subpath exposes the server-entry shape a
// Remote method takes; typert requires Remote boundary types to ride a public
// non-root type subpath.
export type { McpServerEntry } from './config.ts'

/**
 * Connection lifecycle a mounted server reports, plus `unknown` for an
 * unobserved one. `needs-auth` is distinct from `failed`: the server answered
 * and the credential is the only thing missing, so authorizing fixes it —
 * whereas `failed` covers what a user's action cannot repair.
 */
export type McpServerStatusKind = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'needs-auth' | 'unknown'

/**
 * One tool a server currently registers. The view carries both the raw
 * server-side name and the description the MCP `tools/list` response returned;
 * a configuration surface renders the raw name (the public `mcp__<serverName>__…`
 * name is opaque to the user) and uses the description for hover text.
 */
export interface McpToolInfo {
  /** The tool's server-side name as the upstream MCP server reports it. */
  name: string
  /** Human-readable description from the latest `tools/list` response. */
  description: string
}

/** One server's live status as the manager's `list` Remote method returns it. */
export interface McpServerStatusView {
  /** Stable local namespace for this server's model-facing tools. */
  serverName: string
  /** Latest lifecycle state the supervisor reported, or `unknown` while unobserved. */
  status: McpServerStatusKind
  /** Model-facing tools this server currently registers. */
  tools: McpToolInfo[]
  /** Diagnostic text from the latest failure, when one was reported. */
  error?: string
}

/** The raw `mcp.json` text the configuration surface edits in place. */
export interface McpDocumentTextValue {
  readonly text: string
}

/** Confirmation that a `mcp.json` write was validated, persisted, and synced. */
export interface McpDocumentWriteValue {
  readonly ok: true
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
