/**
 * MCP configure-document store: availability from the loopback fact, the
 * in-place read/write of `mcp.json`, and the failure/concurrency recovery.
 */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { McpDocumentStore } from '../src/client/mcp-document-store.ts'

interface Face {
  readMcpDocument?: () => Promise<RemoteResult<{ text: string }>>
  writeMcpDocument?: (text: string) => Promise<RemoteResult<{ ok: true }>>
}

function build(isLoopback: boolean, face: Face = {}) {
  const ctx = {
    remote: {
      $host: { isLoopback },
      mcp: {
        readMcpDocument: face.readMcpDocument ?? (() => Promise.resolve({ ok: true as const, value: { text: '{"mcpServers":{}}' } })),
        writeMcpDocument: face.writeMcpDocument ?? (() => Promise.resolve({ ok: true as const, value: { ok: true as const } })),
      },
    },
  } as never
  return { store: new McpDocumentStore(ctx) }
}

describe('McpDocumentStore', () => {
  it('reports ready and reads the document text on loopback', async () => {
    const readMcpDocument = vi.fn(() => Promise.resolve({ ok: true as const, value: { text: '{"mcpServers":{}}' } }))
    const { store } = build(true, { readMcpDocument })
    await store.load()
    expect(store.store.getSnapshot().status).toBe('ready')
    await store.read()
    expect(readMcpDocument).toHaveBeenCalledOnce()
    expect(store.store.getSnapshot().text).toBe('{"mcpServers":{}}')
  })

  it('reports unavailable and never reads on a non-loopback deployment', async () => {
    const readMcpDocument = vi.fn()
    const { store } = build(false, { readMcpDocument })
    await store.load()
    expect(store.store.getSnapshot().status).toBe('unavailable')
    expect(readMcpDocument).not.toHaveBeenCalled()
  })

  it('collapses concurrent reads and records a failure', async () => {
    let resolveRead!: (value: RemoteResult<{ text: string }>) => void
    const readMcpDocument = vi.fn(() => new Promise<RemoteResult<{ text: string }>>((resolve) => { resolveRead = resolve }))
    const { store } = build(true, { readMcpDocument })
    await store.load()
    const first = store.read()
    const second = store.read()
    expect(readMcpDocument).toHaveBeenCalledTimes(1)
    resolveRead({ ok: false, error: new RemoteError('gateway/internal', 'no document', {}) })
    await Promise.all([first, second])
    expect(store.store.getSnapshot()).toMatchObject({ opening: false, error: 'no document' })
  })

  it('writes a document and records its text on success', async () => {
    const writeMcpDocument = vi.fn(() => Promise.resolve({ ok: true as const, value: { ok: true as const } }))
    const { store } = build(true, { writeMcpDocument })
    const landed = await store.write('{"mcpServers":{}}')
    expect(landed).toBe(true)
    expect(writeMcpDocument).toHaveBeenCalledWith('{"mcpServers":{}}')
    expect(store.store.getSnapshot().text).toBe('{"mcpServers":{}}')
  })

  it('reports a refused write without changing the held text', async () => {
    const writeMcpDocument = vi.fn(() => Promise.resolve({
      ok: false as const,
      error: new RemoteError('gateway/bad-request', 'invalid', {}),
    }))
    const { store } = build(true, { writeMcpDocument })
    const landed = await store.write('not json')
    expect(landed).toBe(false)
    expect(store.store.getSnapshot().error).toBe('invalid')
  })
})
