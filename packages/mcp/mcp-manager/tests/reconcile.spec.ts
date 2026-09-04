/**
 * Tests for the pure reconcile function: the mount/dispose operations that
 * move the live mcp-client set from one server list to another.
 */
import { describe, expect, it } from 'vitest'
import { reconcile, serversEqual } from '@deepseek-ai/dsh-mcp-manager/src/reconcile.ts'
import type { McpServerEntry, McpStdioServer } from '@deepseek-ai/dsh-mcp-manager/src/config.ts'

/** One stdio entry with the given name and overrides. */
function stdio(name: string, overrides: Partial<McpStdioServer> = {}): McpStdioServer {
  return {
    serverName: name,
    enabled: true,
    transport: 'stdio',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    ...overrides,
  }
}

describe('reconcile', () => {
  it('mounts new enabled servers', () => {
    const actions = reconcile([], [stdio('gh')])
    expect(actions).toEqual([{ kind: 'mount', server: stdio('gh') }])
  })

  it('does nothing for a new disabled server', () => {
    const actions = reconcile([], [stdio('gh', { enabled: false })])
    expect(actions).toEqual([])
  })

  it('disposes a removed server', () => {
    const actions = reconcile([stdio('gh')], [])
    expect(actions).toEqual([{ kind: 'dispose', serverName: 'gh' }])
  })

  it('disposes a disabled server without mounting it', () => {
    const actions = reconcile([stdio('gh')], [stdio('gh', { enabled: false })])
    expect(actions).toEqual([{ kind: 'dispose', serverName: 'gh' }])
  })

  it('mounts a re-enabled server', () => {
    const actions = reconcile([stdio('gh', { enabled: false })], [stdio('gh')])
    expect(actions).toEqual([{ kind: 'mount', server: stdio('gh') }])
  })

  it('disposes then mounts a changed-but-enabled server', () => {
    const actions = reconcile([stdio('gh', { command: 'old' })], [stdio('gh', { command: 'new' })])
    expect(actions).toEqual([
      { kind: 'dispose', serverName: 'gh' },
      { kind: 'mount', server: stdio('gh', { command: 'new' }) },
    ])
  })

  it('leaves an unchanged enabled server alone', () => {
    const actions = reconcile([stdio('gh')], [stdio('gh')])
    expect(actions).toEqual([])
  })

  it('orders all disposals before all mounts', () => {
    const prev: McpServerEntry[] = [stdio('a'), stdio('b')]
    const next: McpServerEntry[] = [stdio('b', { command: 'new' }), stdio('c')]
    const actions = reconcile(prev, next)
    // Disposals (a removed, b changed) come first, then mounts (b, c).
    expect(actions.map(action => action.kind)).toEqual(['dispose', 'dispose', 'mount', 'mount'])
    expect(actions[0]).toEqual({ kind: 'dispose', serverName: 'a' })
    expect(actions[1]).toEqual({ kind: 'dispose', serverName: 'b' })
  })

  it('a disabled-and-changed server stays disposed and unmounted', () => {
    const actions = reconcile([stdio('gh')], [stdio('gh', { enabled: false, command: 'new' })])
    expect(actions).toEqual([{ kind: 'dispose', serverName: 'gh' }])
  })
})

describe('serversEqual', () => {
  it('treats equal entries as equal regardless of key order', () => {
    expect(serversEqual(stdio('gh'), stdio('gh'))).toBe(true)
  })

  it('treats a field difference as unequal', () => {
    expect(serversEqual(stdio('gh'), stdio('gh', { command: 'other' }))).toBe(false)
  })

  it('treats a toggled enabled flag as unequal', () => {
    expect(serversEqual(stdio('gh'), stdio('gh', { enabled: false }))).toBe(false)
  })
})
