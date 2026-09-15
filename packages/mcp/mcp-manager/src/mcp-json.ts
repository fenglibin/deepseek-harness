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
import type { McpHttpAuth, McpServerEntry, McpSettings } from './config.ts'
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

/** Read an optional string-array field, rejecting non-string entries and staying absent when unlisted. */
function optionalStringArray(value: unknown, serverName: string, field: string): string[] | undefined {
  if (value === undefined) return undefined
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
export function sanitizeServerName(raw: string): string {
  if (SERVER_NAME_PATTERN.test(raw)) return raw
  return `mcp-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
}

/**
 * Read one `mcp.json` entry's auth mode. Recognition is one-way on purpose: the
 * cross-vendor document carries `authMode: "oauth"` with a vendor's own
 * endpoint conventions, and rendering dsh's endpoint fields back would
 * publish a shape no other platform agrees on. An entry that names OAuth
 * without the endpoints dsh needs therefore fails rather than producing a
 * half-configured server.
 *
 * Because the render omits OAuth, an entry that says nothing about
 * authentication keeps whatever the current section already holds for that
 * server; only an entry with no prior OAuth state resolves to `none`.
 * @param raw - the entry as written in `mcp.json`.
 * @param rawName - the entry's key, for the message of an unusable value.
 * @param previous - the current section's entry of the same name, when one exists.
 * @returns the auth mode the manager should use.
 */
function authOf(raw: Record<string, unknown>, rawName: string, previous?: McpServerEntry): McpHttpAuth {
  if (raw.authMode !== 'oauth') {
    // The render omits OAuth, so the document's silence cannot be read as "no
    // authentication": the entry the manager itself wrote for an authorized
    // server carries no marker, and treating silence as `none` would erase
    // that server's OAuth configuration the next time the user hand-edited an
    // unrelated entry. Silence keeps what the current section already holds.
    if (previous !== undefined && previous.transport === 'streamable-http' && previous.auth?.kind === 'oauth') {
      return previous.auth
    }
    return { kind: 'none' }
  }
  const clientId = typeof raw.clientId === 'string' ? raw.clientId : undefined
  const authorizationUrl = typeof raw.authorizationUrl === 'string' ? raw.authorizationUrl : undefined
  const tokenUrl = typeof raw.tokenUrl === 'string' ? raw.tokenUrl : undefined
  if (clientId === undefined || authorizationUrl === undefined || tokenUrl === undefined) {
    throw new Error(
      `mcp.json server "${rawName}" names OAuth but is missing clientId, authorizationUrl, or tokenUrl`,
    )
  }
  const scopes = optionalStringArray(raw.scopes, rawName, 'scopes')
  return { kind: 'oauth', clientId, authorizationUrl, tokenUrl, ...scopes === undefined ? {} : { scopes } }
}

/**
 * Convert a parsed `mcp.json` into the manager's settings section. Each map
 * entry becomes one server: presence of `command` makes it stdio, presence of
 * `url` makes it Streamable HTTP, and `disabled` maps to the inverse of
 * `enabled`. A server name outside the namespace contract is hashed to a safe
 * one rather than refusing the document; a server with neither command nor
 * url still throws, so a half-edited document never reaches settings.
 * @param json - the parsed document.
 * @param current - the section the document is being synced over. An entry
 *   that says nothing about authentication inherits the auth mode this
 *   section already holds for it, because the render omits OAuth details and
 *   silence must not erase them.
 * @returns the equivalent settings section.
 * @throws {Error} when any entry cannot be converted.
 */
export function mcpJsonToSettings(json: McpJson, current?: McpSettings): McpSettings {
  const servers: McpServerEntry[] = []
  const previousByName = new Map((current?.servers ?? []).map(entry => [entry.serverName, entry]))
  for (const [rawName, raw] of Object.entries(json.mcpServers)) {
    if (!isPlainObject(raw)) {
      throw new Error(`mcp.json server "${rawName}" must be an object`)
    }
    const serverName = sanitizeServerName(rawName)
    const enabled = raw.disabled !== true
    const allowed = optionalStringArray(raw.allowedTools, rawName, 'allowedTools')
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
        ...allowed === undefined ? {} : { allowedTools: allowed },
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
        auth: authOf(raw, rawName, previousByName.get(serverName)),
        ...allowed === undefined ? {} : { allowedTools: allowed },
      })
    } else {
      throw new Error(`mcp.json server "${rawName}" needs a "command" (stdio) or "url" (http)`)
    }
  }
  return { servers }
}

/**
 * The `mcp.json` fields one auth mode writes, or none for `none`.
 *
 * `scopes` follows the same rule as `allowedTools`: written only when the
 * entry carries one, so an omitted list stays omitted rather than becoming an
 * empty array the sync would read back as "request no scopes".
 * @param auth - the entry's auth mode.
 * @returns the document fields to merge into the entry.
 */
function oauthFieldsOf(auth: McpHttpAuth | undefined): Partial<McpJsonServer> {
  if (auth?.kind !== 'oauth') return {}
  return {
    authMode: 'oauth',
    clientId: auth.clientId,
    authorizationUrl: auth.authorizationUrl,
    tokenUrl: auth.tokenUrl,
    ...auth.scopes === undefined ? {} : { scopes: [...auth.scopes] },
  }
}

/**
 * Render the manager's settings section back into `mcp.json` shape. Used to
 * seed a missing `mcp.json` so the first hand-edit starts from what settings
 * already holds, and to re-render one entry on a settings-page edit.
 * `timeout`/`transportType` are dsh-unmanaged and therefore omitted, keeping
 * the document to the fields the sync reads back.
 *
 * `allowedTools` and the OAuth fields are dsh extensions the sync reads back,
 * so both are written whenever the entry carries them. Writing the OAuth fields
 * is what makes a settings-page edit lossless: that editor is a `mcp.json`
 * round trip, so a field the render omits is a field the editor cannot show
 * and the next save therefore erases. An entry that uses no OAuth writes none
 * of them, so its document text is unchanged by this capability.
 * @param settings - the manager's current server list.
 * @returns the equivalent `mcp.json` document.
 */
export function settingsToMcpJson(settings: McpSettings): McpJson {
  const mcpServers: Record<string, McpJsonServer> = {}
  for (const server of settings.servers) {
    const base: McpJsonServer = server.enabled ? {} : { disabled: true }
    const allowed = server.allowedTools === undefined ? {} : { allowedTools: server.allowedTools }
    const auth = server.transport === 'streamable-http' ? oauthFieldsOf(server.auth) : {}
    mcpServers[server.serverName] = server.transport === 'stdio'
      ? {
        ...base,
        type: 'stdio',
        command: server.command,
        args: server.args,
        env: server.env,
        ...(server.cwd === '' ? {} : { cwd: server.cwd }),
        ...allowed,
      }
      : {
        ...base,
        url: server.url,
        headers: server.headers,
        ...auth,
        ...allowed,
      }
  }
  return { mcpServers }
}

/** Render one `mcp.json` document as pretty text with a trailing newline. */
export function renderMcpJson(json: McpJson): string {
  return `${JSON.stringify(json, null, 2)}\n`
}
