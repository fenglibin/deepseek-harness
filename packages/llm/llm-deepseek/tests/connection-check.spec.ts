import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as LlmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import { checkConnection } from '../src/connection-check.ts'
import { PUBLIC_BASE_URL } from '../src/index.ts'
import type { DeepSeekConnectionOptions } from '../src/adapter.ts'

const servers: Server[] = []
const touchedEnv: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const name of touchedEnv.splice(0)) Reflect.deleteProperty(process.env, name)
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface CompletionServer {
  url: string
  paths: string[]
  headers: IncomingMessage['headers'][]
}

async function completionServer(): Promise<CompletionServer> {
  const paths: string[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    headers.push(request.headers)
    request.on('data', () => {})
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"id":"chatcmpl-1"}')
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, headers }
}

async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmDeepseek, config)
  return ctx
}

function options(overrides: Partial<DeepSeekConnectionOptions> = {}): DeepSeekConnectionOptions {
  return {
    baseURL: PUBLIC_BASE_URL,
    apiKeyEnv: 'DEEPSEEK_API_KEY' as never,
    defaults: {},
    maxTokens: 256_000,
    defaultContextWindow: 1_000_000,
    models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000 }],
    streamIdleTimeoutMs: 300_000,
    maxRequestFilesBytes: 1,
    maxInlineRequestImageBytes: 1,
    maxImagesPerRequest: 1,
    imageOffloadByteQuantum: 1,
    inlineImageOffloadByteQuantum: 1,
    imageOffloadCountQuantum: 1,
    filesApiTimeoutMs: 60_000,
    filePolicy: { expiresAfterSeconds: 604_800, refreshMarginSeconds: 3_600, quotaCleanupBatch: 100 },
    retryPolicy: resolveRetryPolicy(undefined, 'connection-check test'),
    ...overrides,
  }
}

describe('deepseek connection check', () => {
  it('probes the endpoint with the draft key and model', async () => {
    const server = await completionServer()
    const ctx = await harness({ baseURL: server.url })

    await expect(ctx.llm.validateConnection('llm-deepseek', {
      provider: 'deepseek-official',
      apiKey: 'typed-key',
      model: 'deepseek-v4-flash',
    })).resolves.toEqual({ baseURL: server.url, model: 'deepseek-v4-flash' })

    expect(server.paths).toEqual(['/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer typed-key')
  })

  it('resolves the endpoint and model from the plugin config when the draft omits them', async () => {
    const server = await completionServer()
    process.env['DEEPSEEK_API_KEY'] = 'stored-key'
    touchedEnv.push('DEEPSEEK_API_KEY')
    const ctx = await harness({ baseURL: server.url })

    // The Models page sends the route and nothing else for an unedited profile.
    await expect(ctx.llm.validateConnection('llm-deepseek', { provider: 'deepseek-official' }))
      .resolves.toEqual({ baseURL: server.url, model: 'deepseek-v4-flash' })
    expect(server.headers[0]?.authorization).toBe('Bearer stored-key')
  })

  it('fails loud when no credential is resolvable', async () => {
    // A probe is a request; a route with no key cannot make one, and the
    // refusal names the reference to fill instead of probing unauthenticated.
    const ctx = await harness()
    await expect(ctx.llm.validateConnection('llm-deepseek', {
      provider: 'deepseek-official',
      baseURL: PUBLIC_BASE_URL,
      model: 'deepseek-v4-flash',
    })).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('refuses a draft whose configured catalog has no model', async () => {
    await expect(checkConnection(
      { provider: 'deepseek-official' },
      options({ models: [] }),
      async () => undefined,
    )).rejects.toThrow(/no model to probe/)
  })

  it('is offered for the namespace and absent from one it does not serve', async () => {
    const ctx = await harness()
    await expect(ctx.llm.validateConnection('llm-pi-ai', { provider: 'openai' }))
      .rejects.toMatchObject({ code: 'NO_CONNECTION_CHECK' })
  })

  it('lets a typed key win over the stored one', async () => {
    const server = await completionServer()
    process.env['DEEPSEEK_API_KEY'] = 'stored-key'
    touchedEnv.push('DEEPSEEK_API_KEY')
    const ctx = await harness({ baseURL: server.url })

    await ctx.llm.validateConnection('llm-deepseek', {
      provider: 'deepseek-official',
      apiKey: 'typed',
    })

    expect(server.headers[0]?.authorization).toBe('Bearer typed')
  })

  it('asks the stored key only when the draft carries none', async () => {
    const asked: string[] = []
    await expect(checkConnection(
      { baseURL: 'http://127.0.0.1:9/v1', model: 'deepseek-v4-flash' },
      options(),
      async () => {
        asked.push('asked')
        return 'stored'
      },
    )).rejects.toMatchObject({ code: 'CONNECTION_CHECK_FAILED' })
    expect(asked).toEqual(['asked'])
  })
})
