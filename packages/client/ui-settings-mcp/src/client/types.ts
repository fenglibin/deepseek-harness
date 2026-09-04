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
}

/** One user-managed MCP server, either stdio or Streamable HTTP. */
export type McpServerEntry = McpStdioServer | McpHttpServer

/** The user-managed MCP server list stored under the `mcp` namespace. */
export interface McpSettings {
  /** Ordered server entries; `serverName` must be unique across the list. */
  servers: McpServerEntry[]
}
