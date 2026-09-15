/**
 * Client-side wire types for the `mcp` settings namespace. These mirror the
 * Host `dsh-mcp-manager` schema exactly, but live in this package so a Client
 * compilation face never imports a Host-only symbol (client bundle purity gate).
 */

/** One stdio MCP server: a local program spawned per connection. */
export interface McpStdioServer {
  /** Stable local namespace for this server's model-facing tools. */
  serverName: string
  /** Whether the manager mounts this server; false keeps the entry inactive. */
  enabled: boolean
  /** Child-process transport discriminator. */
  transport: 'stdio'
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of the scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Raw MCP tool names admitted to registration; omission registers every tool the server lists. */
  allowedTools?: string[]
}

/**
 * How one HTTP server authenticates. `none` sends no credential beyond the
 * entry's own `headers`; `oauth` obtains a bearer token through the
 * authorization-code flow. The token itself never reaches this package: it
 * lives in the Host credential store.
 */
export type McpHttpAuth =
  | { /** Send no credential beyond `headers`. */ kind: 'none' }
  | {
    /** Obtain a bearer token through authorization code + PKCE. */
    kind: 'oauth'
    /** OAuth client identifier registered with the server. */
    clientId: string
    /** Authorization endpoint the browser is sent to. */
    authorizationUrl: string
    /** Token endpoint the code and refresh exchanges POST to. */
    tokenUrl: string
    /** Scopes requested from the server; omission requests none. */
    scopes?: string[]
  }

/** One Streamable HTTP MCP server. */
export interface McpHttpServer {
  /** Stable local namespace for this server's model-facing tools. */
  serverName: string
  /** Whether the manager mounts this server; false keeps the entry inactive. */
  enabled: boolean
  /** Streamable HTTP transport discriminator. */
  transport: 'streamable-http'
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Authentication mode; the Host resolves it to `{ kind: 'none' }` when absent. */
  auth: McpHttpAuth
  /** Raw MCP tool names admitted to registration; omission registers every tool the server lists. */
  allowedTools?: string[]
}

/** One user-managed MCP server, either stdio or Streamable HTTP. */
export type McpServerEntry = McpStdioServer | McpHttpServer

/** The user-managed MCP server list stored under the `mcp` namespace. */
export interface McpSettings {
  /** Ordered server entries; `serverName` must be unique across the list. */
  servers: McpServerEntry[]
}

/**
 * One `mcp.json` server entry in the cross-vendor shape the JSON editor shows.
 * stdio and http fields share one nullable object; the discriminator is the
 * presence of `command` (stdio) versus `url` (http), mirroring the Host
 * `dsh-mcp-manager` document model exactly.
 */
export interface McpJsonServer {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** dsh extension: raw tool names admitted from this server; omission admits every tool. */
  allowedTools?: string[]
  transportType?: string
  timeout?: number
  disabled?: boolean
  /** Read but never written: `oauth` marks an OAuth server dsh can recognize. */
  authMode?: string
  /** Read but never written; required with `authMode: "oauth"`. */
  clientId?: string
  /** Read but never written; required with `authMode: "oauth"`. */
  authorizationUrl?: string
  /** Read but never written; required with `authMode: "oauth"`. */
  tokenUrl?: string
  /** Read but never written; requested scopes for an OAuth server. */
  scopes?: string[]
}
