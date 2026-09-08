/**
 * Pure JSON-shape helpers for the MCP section's add/edit flows. The "add" flow
 * accepts pasted MCP config — either a bare `{ name: server }` map or the
 * cross-vendor `{ "mcpServers": { name: server } }` wrapper — and merges it into
 * the user-editable `mcp.json`; the "edit" flow renders one server entry as the
 * same cross-vendor shape and replaces it in place. Every function here is a
 * pure transform over parsed objects or text, with no React or ctx dependency,
 * so the shape rules stay unit-testable in isolation. Validation of the merged
 * document (command/url presence, field types) stays with the Host
 * `writeMcpDocument`, which refuses a malformed entry and reports it back.
 */

import type { McpJsonServer, McpServerEntry } from './types.ts'

/** Human message for any thrown value, kept local so errors stay plain strings. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a value is a plain object (not an array or null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse pasted MCP config into a server map keyed by raw name. A top-level
 * `mcpServers` object is unwrapped and only its contents are taken, so the
 * common cross-vendor wrapper is accepted; a bare `{ name: server }` map is
 * taken as-is. Each value must be a plain object.
 * @param text - the pasted JSON.
 * @returns the server map in insertion order.
 * @throws {Error} when the text is not JSON, not an object, has no servers, or
 * a server value is not an object.
 */
export function parsePastedServers(text: string): Record<string, McpJsonServer> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`pasted MCP config is not valid JSON: ${messageOf(error)}`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error('pasted MCP config must be a JSON object')
  }
  const source = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed
  const servers: Record<string, McpJsonServer> = {}
  for (const [name, raw] of Object.entries(source)) {
    if (!isPlainObject(raw)) {
      throw new Error(`server "${name}" must be an object`)
    }
    servers[name] = raw
  }
  if (Object.keys(servers).length === 0) {
    throw new Error('pasted MCP config contains no servers')
  }
  return servers
}

/**
 * Parse one `mcp.json` document text into its server map. The document always
 * carries a top-level `mcpServers` object (the Host seeds one on first read).
 * @param text - the full `mcp.json` text.
 * @returns the server map keyed by raw name.
 * @throws {Error} when the text is not JSON or its root is not `{ mcpServers: {} }`.
 */
export function parseDocument(text: string): Record<string, McpJsonServer> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`mcp.json is not valid JSON: ${messageOf(error)}`)
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    throw new Error('mcp.json must contain a "mcpServers" object')
  }
  const servers: Record<string, McpJsonServer> = {}
  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    if (isPlainObject(raw)) servers[name] = raw
  }
  return servers
}

/**
 * Parse one server's edited JSON back into the cross-vendor server object.
 * @param text - the edited server JSON.
 * @returns the server object.
 * @throws {Error} when the text is not JSON or not an object.
 */
export function parseSingleServer(text: string): McpJsonServer {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`server config is not valid JSON: ${messageOf(error)}`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error('server config must be a JSON object')
  }
  return parsed
}

/**
 * Render one server entry as pretty cross-vendor JSON for the edit editor.
 * `enabled: false` maps to `disabled: true` (the inverse of the Host's
 * `disabled !== true` read), and `cwd` is omitted when empty so the shape stays
 * the fields the document sync reads back. `allowedTools` is a dsh extension
 * and is written only when the entry carries one.
 * @param entry - the server entry to render.
 * @returns the pretty JSON text with a trailing newline.
 */
export function entryToServerJson(entry: McpServerEntry): string {
  const base: McpJsonServer = entry.enabled ? {} : { disabled: true }
  const allowed = entry.allowedTools === undefined ? {} : { allowedTools: entry.allowedTools }
  const server: McpJsonServer = entry.transport === 'stdio'
    ? {
      ...base,
      type: 'stdio',
      command: entry.command,
      args: entry.args,
      env: entry.env,
      ...(entry.cwd === '' ? {} : { cwd: entry.cwd }),
      ...allowed,
    }
    : {
      ...base,
      url: entry.url,
      headers: entry.headers,
      ...allowed,
    }
  return `${JSON.stringify(server, null, 2)}\n`
}

/**
 * Render one server map back into `mcp.json` document text.
 * @param servers - the server map keyed by raw name.
 * @returns the pretty `{ mcpServers: ... }` text with a trailing newline.
 */
export function renderDocument(servers: Record<string, McpJsonServer>): string {
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`
}

/**
 * Convert one cross-vendor server object back into a settings entry, keyed by
 * the given name. Presence of `command` makes it stdio, `url` makes it http, and
 * `disabled` maps to the inverse of `enabled` — the exact inverse of the Host's
 * `mcpJsonToSettings`. The entry is handed to the Host single-server update,
 * which re-validates and re-renders it, so a half-edited object is refused there.
 * @param name - the server name the entry is keyed by (already namespace-safe).
 * @param json - the edited cross-vendor server object.
 * @returns the equivalent settings entry.
 * @throws {Error} when the object has neither `command` nor `url`.
 */
export function serverJsonToEntry(name: string, json: McpJsonServer): McpServerEntry {
  const enabled = json.disabled !== true
  const allowed = json.allowedTools === undefined ? {} : { allowedTools: json.allowedTools }
  if (json.command !== undefined) {
    return {
      serverName: name,
      enabled,
      transport: 'stdio',
      command: json.command,
      args: json.args ?? [],
      env: json.env ?? {},
      cwd: typeof json.cwd === 'string' ? json.cwd : '',
      ...allowed,
    }
  }
  if (json.url !== undefined) {
    return {
      serverName: name,
      enabled,
      transport: 'streamable-http',
      url: json.url,
      headers: json.headers ?? {},
      ...allowed,
    }
  }
  throw new Error(`server "${name}" needs a "command" (stdio) or "url" (http)`)
}
