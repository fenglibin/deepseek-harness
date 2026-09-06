/**
 * MCP manager plugin: owns one user-managed list of MCP servers and mounts an
 * mcp-client instance per enabled entry, reconciling the live set on every
 * settings change. It is the user-facing counterpart to the bare mcp-client
 * plugin — users add, edit, enable, disable, and remove servers here instead
 * of hand-editing cordis.yml rows, and the list persists in the settings
 * document, not in the plugin tree.
 * @module @deepseek-ai/dsh-mcp-manager
 */

export { MCP_SETTINGS_NAMESPACE, MCP_SETTINGS_SCHEMA, SERVER_NAME_PATTERN, validateServers } from './config.ts'
export type { McpHttpServer, McpServerEntry, McpSettings, McpStdioServer } from './config.ts'
export { MCP_JSON_FILENAME, mcpJsonToSettings, parseMcpJson, renderMcpJson, settingsToMcpJson } from './mcp-json.ts'
export type { McpJson, McpJsonServer } from './mcp-json.ts'
export { reconcile, serversEqual } from './reconcile.ts'
export type { ReconcileAction } from './reconcile.ts'
export { McpManager } from './manager.ts'
export type { McpServerStatus } from './manager.ts'
export type { McpDocumentOpenValue, McpServerStatusKind, McpServerStatusView } from './status.ts'

import { McpManager } from './manager.ts'
export default McpManager
