import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeOpenAiChatCompletion, userAgent } from '@deepseek-ai/dsh-llm'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface ProbeServer {
  url: string
  paths: string[]
  headers: IncomingMessage['headers'][]
  bodies: string[]
}

/**
 * A stand-in endpoint that answers one scripted chat completion. `chunks`
 * writes without a declared length, which is how a real streamed reply arrives.
 */
async function probeServer(behavior: {
  status?: number
  body?: string
  chunks?: string[]
}): Promise<ProbeServer> {
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
      if (behavior.chunks !== undefined) {
        response.writeHead(behavior.status ?? 200, { 'content-type': 'application/json' })
        for (const chunk of behavior.chunks) response.write(chunk)
        response.end()
        return
      }
      const body = behavior.body ?? '{}'
      response.writeHead(behavior.status ?? 200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      })
      response.end(body)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, headers, bodies }
}

describe('openai chat completion probe', () => {
  it('sends the hello completion and reports what answered', async () => {
    const server = await probeServer({ body: '{"id":"chatcmpl-1"}' })

    await expect(probeOpenAiChatCompletion({
      baseURL: `${server.url}/v1/`,
      model: 'acme-large',
      apiKey: 'probe-key',
    })).resolves.toEqual({ baseURL: `${server.url}/v1/`, model: 'acme-large' })

    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer probe-key')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
    expect(JSON.parse(server.bodies[0] ?? '{}')).toEqual({
      model: 'acme-large',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
    })
  })

  it('probes unauthenticated when no key is supplied', async () => {
    const server = await probeServer({})

    await probeOpenAiChatCompletion({ baseURL: server.url, model: 'm' })

    expect(server.headers[0]?.authorization).toBeUndefined()
  })

  it('points at the credential for a 401 and a 403, and only then', async () => {
    for (const status of [401, 403]) {
      const refused = await probeServer({ status, body: '{"error":"nope"}' })
      await expect(probeOpenAiChatCompletion({ baseURL: refused.url, model: 'm', apiKey: 'wrong' }))
        .rejects.toThrow(new RegExp(`answered ${status}; check the API key`))
    }

    const broken = await probeServer({ status: 500, body: '{"error":"boom"}' })
    await expect(probeOpenAiChatCompletion({ baseURL: broken.url, model: 'm', apiKey: 'fine' }))
      .rejects.toThrow(/answered 500$/)
  })

  it('carries the provider\'s own wording for a JSON refusal and drops a non-JSON one', async () => {
    const explained = await probeServer({
      status: 400,
      body: '{"error":{"message":"unknown model acme-large"}}',
    })
    await expect(probeOpenAiChatCompletion({ baseURL: explained.url, model: 'acme-large' }))
      .rejects.toThrow(/answered 400: unknown model acme-large/)

    const opaque = await probeServer({ status: 400, body: 'not json' })
    await expect(probeOpenAiChatCompletion({ baseURL: opaque.url, model: 'acme-large' }))
      .rejects.toThrow(/answered 400$/)
  })

  it('reports an unreachable endpoint', async () => {
    // Port 9 is the discard service: nothing accepts a connection there.
    await expect(probeOpenAiChatCompletion({ baseURL: 'http://127.0.0.1:9/v1', model: 'm' }))
      .rejects.toMatchObject({ code: 'CONNECTION_CHECK_FAILED' })
  })

  it('reports an illegal or blank probe key as a credential fault, not a transport one', async () => {
    await expect(probeOpenAiChatCompletion({
      baseURL: 'https://acme.test',
      model: 'm',
      apiKey: 'sk-\u{1F600}',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })

    await expect(probeOpenAiChatCompletion({
      baseURL: 'https://acme.test',
      model: 'm',
      apiKey: '',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('honors caller cancellation before the request goes out', async () => {
    await expect(probeOpenAiChatCompletion({
      baseURL: 'http://127.0.0.1:9/v1',
      model: 'm',
      signal: AbortSignal.abort('test cancellation'),
    })).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('bounds a refusal body whether its length is declared or streamed', async () => {
    const oversized = `{"error":{"message":"${'x'.repeat(64 * 1024)}"}}`

    const declared = await probeServer({ status: 400, body: oversized })
    await expect(probeOpenAiChatCompletion({ baseURL: declared.url, model: 'm' }))
      .rejects.toThrow(/answered 400/)

    const streamed = await probeServer({
      status: 400,
      chunks: ['{"error":{"message":"', 'x'.repeat(64 * 1024), '"}}'],
    })
    await expect(probeOpenAiChatCompletion({ baseURL: streamed.url, model: 'm' }))
      .rejects.toThrow(/answered 400/)
  })
})
