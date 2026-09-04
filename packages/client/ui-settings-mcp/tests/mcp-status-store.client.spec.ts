/**
 * MCP status store: one pull of the Host `mcp` Remote namespace, the
 * per-server lookup, and a refresh that re-pulls after forcing a reconnect.
 */
import { describe, expect, it, vi } from 'vitest'
import type { McpServerStatusView } from '@deepseek-ai/dsh-api-remotes/client'
import { McpStatusStore } from '../src/client/mcp-status-store.ts'

/** One status view with the given name and lifecycle state. */
function view(name: string, status: McpServerStatusView['status'], tools: string[] = []): McpServerStatusView {
  return { serverName: name, status, tools }
}

/** The Remote answers the status store consumes. */
type ListAnswer =
  | { readonly ok: true; readonly value: McpServerStatusView[] }
  | { readonly ok: false; readonly error: unknown }
type RefreshAnswer =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly error: unknown }

/** The store over a scripted `remote.mcp` face. */
function build(options?: { list?: () => Promise<ListAnswer>; refresh?: () => Promise<RefreshAnswer> }) {
  const list = vi.fn(options?.list ?? (() => Promise.resolve({
    ok: true as const,
    value: [view('srv', 'connected', ['mcp__srv__remote'])],
  })))
  const refresh = vi.fn(options?.refresh ?? (() => Promise.resolve({ ok: true as const, value: true })))
  const listeners = new Set<() => void>()
  const on = vi.fn((_event: string, listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  const ctx = { remote: { mcp: { list, refresh }, $on: on } } as never
  const store = new McpStatusStore(ctx)
  return { store, list, refresh, on, listeners }
}

describe('McpStatusStore', () => {
  it('loads the status list once and looks it up by server name', async () => {
    const { store, list } = build()
    await store.load()
    expect(list).toHaveBeenCalledTimes(1)
    expect(store.statusOf('srv')).toMatchObject({ serverName: 'srv', status: 'connected' })
  })

  it('refreshes a server and re-pulls the list', async () => {
    const { store, list, refresh } = build()
    await store.load()
    await store.refresh('srv')
    expect(refresh).toHaveBeenCalledWith('srv')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps the last status when a pull fails', async () => {
    const { store, list } = build()
    await store.load()
    list.mockResolvedValueOnce({ ok: false, error: new Error('down') })
    await store.load()
    expect(store.statusOf('srv')).toMatchObject({ status: 'connected' })
  })

  it('re-pulls when the manager pushes a status change', async () => {
    const { store, list, listeners } = build()
    await store.load()
    expect(list).toHaveBeenCalledTimes(1)

    for (const listener of listeners) listener()
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(store.statusOf('srv')).toMatchObject({ status: 'connected' })
  })

  it('stops re-pulling after dispose drops the subscription', async () => {
    const { store, list, listeners } = build()
    await store.load()
    store.dispose()

    for (const listener of listeners) listener()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(list).toHaveBeenCalledTimes(1)
  })
})
