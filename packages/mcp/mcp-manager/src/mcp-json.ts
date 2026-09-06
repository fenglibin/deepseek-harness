/**
 * The `mcp.json` document model and its conversion to the dsh `McpSettings`
 * shape. `mcp.json` follows the cross-vendor `mcpServers` convention (the same
 * file shape every major MCP platform publishes), while the manager's settings
 * namespace stores an ordered `servers` array; this module owns the one-way
 * parse-and-convert path that syncs the former into the latter, plus the
 * reverse render used to seed a missing `mcp.json`.
 * @module @deepseek-ai/dsh-mcp-manager/mcp-json
 */

import { createHash } from 'node:crypto'
import type { McpServerEntry, McpSettings } from './config.ts'
import { SERVER_NAME_PATTERN } from './config.ts'

/** Filename of the user-editable MCP document, beside the settings document. */
export const MCP_JSON_FILENAME = 'mcp.json'

/** The `mcp.json` root: a map keyed by server name. */
export interface McpJson {
  mcpServers: Record<string, McpJsonServer>
}

/**
 * One `mcp.json` server entry. stdio and http fields share one nullable shape,
 * mirroring the loose cross-vendor format; the discriminator is presence of
 * `command` (stdio) versus `url` (http).
 */
export interface McpJsonServer {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  transportType?: string
  timeout?: number
  disabled?: boolean
}

/** Human message for any thrown value, kept local so errors stay plain strings. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a value is a plain object (not an array or null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an optional string-array field, rejecting non-string entries. */
function stringArray(value: unknown, serverName: string, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`mcp.json server "${serverName}" ${field} must be an array of strings`)
  }
  return value as string[]
}

/** Read an optional string-map field, rejecting non-string values. */
function stringRecord(value: unknown, serverName: string, field: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isPlainObject(value) || Object.values(value).some(entry => typeof entry !== 'string')) {
    throw new Error(`mcp.json server "${serverName}" ${field} must be an object of string values`)
  }
  return value as Record<string, string>
}

/**
 * Parse and structurally validate one `mcp.json` document text. This is the
 * format gate the sync path runs before anything reaches settings: a malformed
 * or mis-shaped document throws and is never written through.
 * @param text - raw `mcp.json` text.
 * @returns the parsed document.
 * @throws {Error} when the text is not JSON or its root is not `{ mcpServers: {} }`.
 */
export function parseMcpJson(text: string): McpJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`mcp.json is not valid JSON: ${messageOf(error)}`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error('mcp.json root must be a JSON object')
  }
  const servers = parsed.mcpServers
  if (servers === undefined) {
    throw new Error('mcp.json must contain a "mcpServers" object')
  }
  if (!isPlainObject(servers)) {
    throw new Error('mcp.json "mcpServers" must be an object keyed by server name')
  }
  return { mcpServers: servers as Record<string, McpJsonServer> }
}

/**
 * Map an arbitrary `mcp.json` server name onto a namespace-safe `serverName`.
 * A name already matching the contract (letters, digits, `-`, `_`) passes
 * through unchanged; anything else — CJK or other symbols — becomes a stable
 * `mcp-<sha256 hex>` so one user's exotic input cannot refuse the whole sync.
 * @param raw - the server name as written in `mcp.json`.
 * @returns a name matching {@link SERVER_NAME_PATTERN}.
 */
function sanitizeServerName(raw: string): string {
  if (SERVER_NAME_PATTERN.test(raw)) return raw
  return `mcp-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
}

/**
 * Convert a parsed `mcp.json` into the manager's settings section. Each map
 * entry becomes one server: presence of `command` makes it stdio, presence of
 * `url` makes it Streamable HTTP, and `disabled` maps to the inverse of
 * `enabled`. A server name outside the namespace contract is hashed to a safe
 * one rather than refusing the document; a server with neither command nor
 * url still throws, so a half-edited document never reaches settings.
 * @param json - the parsed document.
 * @returns the equivalent settings section.
 * @throws {Error} when any entry cannot be converted.
 */
export function mcpJsonToSettings(json: McpJson): McpSettings {
  const servers: McpServerEntry[] = []
  for (const [rawName, raw] of Object.entries(json.mcpServers)) {
    if (!isPlainObject(raw)) {
      throw new Error(`mcp.json server "${rawName}" must be an object`)
    }
    const serverName = sanitizeServerName(rawName)
    const enabled = raw.disabled !== true
    if (raw.command !== undefined) {
      if (typeof raw.command !== 'string' || raw.command.length === 0) {
        throw new Error(`mcp.json server "${rawName}" command must be a non-empty string`)
      }
      servers.push({
        serverName,
        enabled,
        transport: 'stdio',
        command: raw.command,
        args: stringArray(raw.args, rawName, 'args'),
        env: stringRecord(raw.env, rawName, 'env'),
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      })
    } else if (raw.url !== undefined) {
      if (typeof raw.url !== 'string' || raw.url.length === 0) {
        throw new Error(`mcp.json server "${rawName}" url must be a non-empty string`)
      }
      servers.push({
        serverName,
        enabled,
        transport: 'streamable-http',
        url: raw.url,
        headers: stringRecord(raw.headers, rawName, 'headers'),
      })
    } else {
      throw new Error(`mcp.json server "${rawName}" needs a "command" (stdio) or "url" (http)`)
    }
  }
  return { servers }
}

/**
 * Render the manager's settings section back into `mcp.json` shape. Used to
 * seed a missing `mcp.json` so the first hand-edit starts from what settings
 * already holds. `timeout`/`transportType` are dsh-unmanaged and therefore
 * omitted, keeping the document to the fields the sync reads back.
 * @param settings - the manager's current server list.
 * @returns the equivalent `mcp.json` document.
 */
export function settingsToMcpJson(settings: McpSettings): McpJson {
  const mcpServers: Record<string, McpJsonServer> = {}
  for (const server of settings.servers) {
    const base: McpJsonServer = server.enabled ? {} : { disabled: true }
    mcpServers[server.serverName] = server.transport === 'stdio'
      ? {
        ...base,
        type: 'stdio',
        command: server.command,
        args: server.args,
        env: server.env,
        ...(server.cwd === '' ? {} : { cwd: server.cwd }),
      }
      : {
        ...base,
        url: server.url,
        headers: server.headers,
      }
  }
  return { mcpServers }
}

/** Render one `mcp.json` document as pretty text with a trailing newline. */
export function renderMcpJson(json: McpJson): string {
  return `${JSON.stringify(json, null, 2)}\n`
}
