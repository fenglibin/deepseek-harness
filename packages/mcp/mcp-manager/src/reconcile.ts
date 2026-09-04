/**
 * Pure reconciliation between two MCP server lists: the operations that move
 * the live mcp-client set from `prev` to `next`. Callers guarantee `serverName`
 * uniqueness per list (the settings namespace's validate hook does this).
 * @module @deepseek-ai/dsh-mcp-manager/reconcile
 */

import type { McpServerEntry } from './config.ts'

/** One operation that moves the live set toward the next configuration. */
export type ReconcileAction =
  | { kind: 'mount'; server: McpServerEntry }
  | { kind: 'dispose'; serverName: string }

/** Whether two entries carry the same effective configuration. */
export function serversEqual(left: McpServerEntry, right: McpServerEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Compute the ordered operations that reconcile two server lists. Disposals
 * precede mounts, so a changed entry that keeps its `serverName` releases the
 * old mcp-client instance before the new one reserves the namespace.
 * @param prev - the previously applied server list.
 * @param next - the desired server list.
 * @returns disposals first, then mounts, each in list order.
 */
export function reconcile(prev: readonly McpServerEntry[], next: readonly McpServerEntry[]): ReconcileAction[] {
  const prevByName = new Map(prev.map(server => [server.serverName, server] as const))
  const nextByName = new Map(next.map(server => [server.serverName, server] as const))
  const actions: ReconcileAction[] = []

  // Phase 1: disposals for removed, disabled, and changed-while-enabled entries.
  for (const [serverName, previous] of prevByName) {
    const nextServer = nextByName.get(serverName)
    const shouldDispose = nextServer === undefined
      || !nextServer.enabled
      || (previous.enabled && !serversEqual(previous, nextServer))
    if (shouldDispose) actions.push({ kind: 'dispose', serverName })
  }

  // Phase 2: mounts for new, re-enabled, and changed-while-enabled entries.
  for (const [serverName, nextServer] of nextByName) {
    if (!nextServer.enabled) continue
    const previous = prevByName.get(serverName)
    const shouldMount = previous === undefined
      || !previous.enabled
      || !serversEqual(previous, nextServer)
    if (shouldMount) actions.push({ kind: 'mount', server: nextServer })
  }

  return actions
}
