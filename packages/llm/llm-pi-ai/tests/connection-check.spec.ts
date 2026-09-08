import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { checkConnection } from '../src/connection-check.ts'

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
  bodies: string[]
}

async function completionServer(behavior: { status?: number } = {}): Promise<CompletionServer> {
  const paths: string[] = []
  const headers: IncomingMessage['headers'][] = []
  const bodies: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    headers.push(request.headers)
    const received: Buffer[] = []
    request.on('data', (chunk) => { received.push(chunk as Buffer) })
    request.on('end', () => {
      bodies.push(Buffer.concat(received).toString('utf8'))
      response.writeHead(behavior.status ?? 200, { 'content-type': 'application/json' })
      response.end('{"id":"chatcmpl-1"}')
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, headers, bodies }
}

async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

describe('pi-ai connection check', () => {
  it('probes a draft endpoint over the wire and reports what answered', async () => {
    const server = await completionServer()
    const ctx = await harness()

    await expect(ctx.llm.validateConnection('llm-pi-ai', {
      baseURL: `${server.url}/v1`,
      api: 'openai-completions',
      apiKey: 'typed-key',
      model: 'acme-large',
    })).resolves.toEqual({ baseURL: `${server.url}/v1`, model: 'acme-large' })

    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer typed-key')
    expect(JSON.parse(server.bodies[0] ?? '{}')).toEqual({
      model: 'acme-large',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
    })
  })

  it('defaults an omitted protocol to openai-completions', async () => {
    const server = await completionServer()
    const ctx = await harness()

    await ctx.llm.validateConnection('llm-pi-ai', {
      baseURL: server.url,
      model: 'acme-large',
    })

    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('resolves the endpoint and model from the stored profile of a hand-declared route', async () => {
    const server = await completionServer()
    process.env['ACME_GATEWAY_KEY'] = 'stored-key'
    touchedEnv.push('ACME_GATEWAY_KEY')
    const ctx = await harness({
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'ACME_GATEWAY_KEY',
          api: 'openai-completions',
          baseURL: server.url,
          models: [{ id: 'acme-large' }],
        },
      },
    })

    // The draft names only the route; the stored profile supplies the rest.
    await expect(ctx.llm.validateConnection('llm-pi-ai', { provider: 'acme-gateway' }))
      .resolves.toEqual({ baseURL: server.url, model: 'acme-large' })
    expect(server.headers[0]?.authorization).toBe('Bearer stored-key')
  })

  it('refuses a protocol it cannot probe rather than guessing a shape', async () => {
    const ctx = await harness()
    await expect(ctx.llm.validateConnection('llm-pi-ai', {
      baseURL: 'https://gateway.example/v1',
      api: 'anthropic-messages',
    })).rejects.toMatchObject({ code: 'CONNECTION_CHECK_UNSUPPORTED' })
  })

  it('refuses a draft with no endpoint to probe', async () => {
    const ctx = await harness()
    await expect(ctx.llm.validateConnection('llm-pi-ai', { provider: 'acme-gateway' }))
      .rejects.toMatchObject({ code: 'CONNECTION_CHECK_FAILED' })
    await expect(ctx.llm.validateConnection('llm-pi-ai', { provider: '', baseURL: '' }))
      .rejects.toMatchObject({ code: 'INVALID_CONNECTION_CHECK' })
  })

  it('refuses a draft with no model to probe', async () => {
    // An endpoint with no route and no model leaves the module nothing to
    // address, so it names the field the user has to fill before any network.
    await expect(checkConnection(
      { baseURL: 'https://gateway.example/v1' },
      { profile: undefined, storedApiKey: async () => undefined },
    )).rejects.toThrow(/no model to probe/)
  })

  it('resolves a catalog route\'s endpoint and model from the installed registry', async () => {
    // pi-ai ships the endpoint and the model list for its own providers, so a
    // draft naming only the route reaches the probe with both resolved. A
    // stubbed fetch captures what the probe would send without any network.
    const requested: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      requested.push(String(url))
      return new Response('{"id":"chatcmpl-1"}', { status: 200 })
    })

    const result = await checkConnection(
      { provider: 'openai' },
      { profile: undefined, storedApiKey: async () => undefined },
    )
    expect(result.baseURL).toBe('https://api.openai.com/v1')
    expect(result.model.length).toBeGreaterThan(0)

    expect(requested[0]).toMatch(/^https:\/\/api\.openai\.com\/v1\/chat\/completions$/)
  })

  it('lets a typed key win over the stored one', async () => {
    const server = await completionServer()
    process.env['ACME_GATEWAY_KEY'] = 'stored-key'
    touchedEnv.push('ACME_GATEWAY_KEY')
    const ctx = await harness({
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'ACME_GATEWAY_KEY',
          api: 'openai-completions',
          baseURL: server.url,
          models: [{ id: 'acme-large' }],
        },
      },
    })

    await ctx.llm.validateConnection('llm-pi-ai', {
      provider: 'acme-gateway',
      apiKey: 'typed',
    })

    expect(server.headers[0]?.authorization).toBe('Bearer typed')
  })

  it('is offered for the namespace, withdrawn with the plugin, and absent elsewhere', async () => {
    const ctx = await harness()
    await expect(ctx.llm.validateConnection('llm-deepseek', { provider: 'deepseek-official' }))
      .rejects.toMatchObject({ code: 'NO_CONNECTION_CHECK' })
    await expect(ctx.llm.validateConnection('llm-pi-ai', { baseURL: '' }))
      .rejects.toMatchObject({ code: 'INVALID_CONNECTION_CHECK' })
  })

  it('asks the stored profile for a key only when the draft carries none', async () => {
    const asked: string[] = []
    vi.stubGlobal('fetch', async () => {
      return new Response('{"id":"chatcmpl-1"}', { status: 200 })
    })

    await checkConnection(
      { baseURL: 'https://gateway.example/v1', model: 'acme-large' },
      {
        profile: undefined,
        storedApiKey: async () => {
          asked.push('asked')
          return undefined
        },
      },
    )

    expect(asked).toEqual(['asked'])
  })
})
