/**
 * Settings schema and types for the MCP manager: one user-owned list of MCP
 * server entries, each of which the manager mounts as an mcp-client instance
 * under the same `serverName`. Only the fields a user manages in the UI are
 * here — the reconnect policy, per-call timeout, and startup semantics stay
 * the mcp-client defaults.
 * @module @deepseek-ai/dsh-mcp-manager/config
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace carrying the user's MCP server list. */
export const MCP_SETTINGS_NAMESPACE = 'mcp'

/** Valid `serverName`, kept identical to the mcp-client namespace contract. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

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
  /** Extra env vars merged on top of the scrubbed ambient env; shown and edited in the UI. */
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
  /** Additional headers attached to MCP requests; shown and edited in the UI. */
  headers: Record<string, string>
}

/** One user-managed MCP server, either stdio or Streamable HTTP. */
export type McpServerEntry = McpStdioServer | McpHttpServer

/** The user-managed MCP server list stored under {@link MCP_SETTINGS_NAMESPACE}. */
export interface McpSettings {
  /** Ordered server entries; `serverName` must be unique across the list. */
  servers: McpServerEntry[]
}

const ServerNameSchema = z.string().pattern(SERVER_NAME_PATTERN)

/** Schema of one stdio server entry; env values never ride a wire read. */
const StdioServerSchema = z.object({
  serverName: ServerNameSchema,
  enabled: z.boolean().default(true),
  transport: z.const('stdio'),
  command: z.string().required(),
  args: z.array(String).default([]),
  // Not role('secret'): the server list is edited wholesale from the wire view,
  // which silently drops any redacted field it never received.
  env: z.dict(String).default({}),
  cwd: z.string().default(''),
})

/** Schema of one Streamable HTTP server entry; header values never ride a wire read. */
const HttpServerSchema = z.object({
  serverName: ServerNameSchema,
  enabled: z.boolean().default(true),
  transport: z.const('streamable-http'),
  url: z.string().required(),
  // Not role('secret'): see the stdio env field — the list is edited wholesale.
  headers: z.dict(String).default({}),
})

/** Settings schema for {@link MCP_SETTINGS_NAMESPACE}, typed to {@link McpSettings}. */
export const MCP_SETTINGS_SCHEMA: z<McpSettings> = z.object({
  servers: z.array(z.union([StdioServerSchema, HttpServerSchema])).default([]),
})

/**
 * Refuse a section whose server list reuses a `serverName`. The schema cannot
 * express cross-entry uniqueness, so this runs as the namespace's validate hook
 * and rejects the write before anything persists.
 * @param value - the resolved section, schema-valid by construction.
 */
export function validateServers(value: McpSettings): void {
  const seen = new Set<string>()
  for (const server of value.servers) {
    if (seen.has(server.serverName)) {
      throw new Error(`mcp-manager: duplicate serverName "${server.serverName}" in the MCP server list`)
    }
    seen.add(server.serverName)
  }
}
