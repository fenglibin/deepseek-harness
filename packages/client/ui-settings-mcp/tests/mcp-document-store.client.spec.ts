/**
 * MCP configure-document store: availability from the loopback fact, the
 * pathless Host open of `mcp.json`, and the failure/concurrency recovery.
 */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { McpDocumentStore } from '../src/client/mcp-document-store.ts'

function build(isLoopback: boolean, openMcpDocument?: () => Promise<RemoteResult<{ opened: true }>>) {
  const ctx = {
    remote: {
      $host: { isLoopback },
      mcp: { openMcpDocument: openMcpDocument ?? (() => Promise.resolve({ ok: true as const, value: { opened: true as const } })) },
    },
  } as never
  return { store: new McpDocumentStore(ctx) }
}

describe('McpDocumentStore', () => {
  it('reports ready and opens the document on loopback', async () => {
    const openMcpDocument = vi.fn(() => Promise.resolve({ ok: true as const, value: { opened: true as const } }))
    const { store } = build(true, openMcpDocument)
    await store.load()
    expect(store.store.getSnapshot().status).toBe('ready')
    await store.open()
    expect(openMcpDocument).toHaveBeenCalledOnce()
  })

  it('reports unavailable and never opens on a non-loopback deployment', async () => {
    const openMcpDocument = vi.fn()
    const { store } = build(false, openMcpDocument)
    await store.load()
    expect(store.store.getSnapshot().status).toBe('unavailable')
    await store.open()
    expect(openMcpDocument).not.toHaveBeenCalled()
  })

  it('collapses concurrent open gestures and records a failure', async () => {
    let resolveOpen!: (value: RemoteResult<{ opened: true }>) => void
    const openMcpDocument = vi.fn(() => new Promise<RemoteResult<{ opened: true }>>((resolve) => { resolveOpen = resolve }))
    const { store } = build(true, openMcpDocument)
    await store.load()
    const first = store.open()
    const second = store.open()
    expect(openMcpDocument).toHaveBeenCalledOnce()
    resolveOpen({ ok: false, error: new RemoteError('gateway/internal', 'no editor', {}) })
    await Promise.all([first, second])
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready', opening: false, error: 'no editor',
    })
  })
})
