import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmImageUnderstanding, {
  DEFAULT_INSTRUCTION,
  describeForRoute,
  routeExcludesImages,
} from '../src/index.ts'

const TEXT: readonly StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  A red traffic light.  ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const BLANK: readonly StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '   ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const FAILED: readonly StreamChunk[] = [
  { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream exploded', code: 'AUTH' } } },
]

const ABORTED: readonly StreamChunk[] = [
  { type: 'finish', reason: { kind: 'aborted', failure: { message: 'caller hung up', code: 'ABORT' } } },
]

/** Adapter that records requests and answers with one fixed script. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[],
    private readonly models: readonly LlmModelInfo[] = [],
    private readonly failure?: () => void,
  ) {
    super()
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(_provider: string, model: string): Promise<LlmModelInfo> {
    const found = this.models.find(entry => entry.id === model)
    return Promise.resolve(found ?? { provider: 'vision', id: model, name: model, inputModalities: ['text'] })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.failure?.()
    yield * this.script
  }
}

function ref(id: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${id}`),
    mediaType: 'image/png',
    bytes: 8,
    width: 2,
    height: 2,
  }
}

function visionModel(id = 'vision-exp'): LlmModelInfo {
  return { provider: 'vision', id, name: id, inputModalities: ['text', 'image'] }
}

function textModel(id = 'text-only'): LlmModelInfo {
  return { provider: 'vision', id, name: id, inputModalities: ['text'] }
}

/** Fresh context carrying the real LLM runtime and no adapters. */
async function llmContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  return ctx
}

describe('LlmImageUnderstanding construction', () => {
  it('rejects a provider without a model', async () => {
    const ctx = await llmContext()
    expect(() => new LlmImageUnderstanding(ctx, { provider: 'vision' }))
      .toThrow('image-understanding: provider and model must be set together or both left empty')
  })

  it('rejects a blank instruction', async () => {
    const ctx = await llmContext()
    expect(() => new LlmImageUnderstanding(ctx, { instruction: '   ' }))
      .toThrow('image-understanding: instruction must not be blank')
  })

  it('rejects a deadline longer than the timer can represent', async () => {
    const ctx = await llmContext()
    expect(() => new LlmImageUnderstanding(ctx, { timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(`image-understanding: timeoutMs must not exceed ${String(MAX_TIMER_DELAY_MS)}`)
  })

  it('rejects a bound that is not a positive safe integer', async () => {
    const zero = await llmContext()
    expect(() => new LlmImageUnderstanding(zero, { maxOutputTokens: 0 }))
      .toThrow('image-understanding: maxOutputTokens must be a positive safe integer')
    const fractional = await llmContext()
    expect(() => new LlmImageUnderstanding(fractional, { maxCacheEntries: 1.5 }))
      .toThrow('image-understanding: maxCacheEntries must be a positive safe integer')
  })

  it('rejects a request-image bound that is not a positive safe integer', async () => {
    const zero = await llmContext()
    expect(() => new LlmImageUnderstanding(zero, { requestImagePixelBudget: 0 }))
      .toThrow('image-understanding: requestImagePixelBudget must be a positive safe integer')
    const fractional = await llmContext()
    expect(() => new LlmImageUnderstanding(fractional, { requestImageMaxBytes: 1.5 }))
      .toThrow('image-understanding: requestImageMaxBytes must be a positive safe integer')
    const unsafe = await llmContext()
    expect(() => new LlmImageUnderstanding(unsafe, { requestImagePixelBudget: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow('image-understanding: requestImagePixelBudget must be a positive safe integer')
  })
})

describe('LlmImageUnderstanding.resolveRoute', () => {
  it('uses the configured route and validates image input', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(TEXT, [visionModel()]))
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })

    await expect(service.resolveRoute()).resolves.toEqual({
      provider: 'vision',
      model: 'vision-exp',
      instruction: DEFAULT_INSTRUCTION,
    })
  })

  it('throws when the configured route cannot accept images', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(TEXT, [textModel()]))
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'text-only' })

    await expect(service.resolveRoute()).rejects.toThrow('does not accept image input')
  })

  it('throws when the configured provider is not registered', async () => {
    const ctx = await llmContext()
    const service = new LlmImageUnderstanding(ctx, { provider: 'absent', model: 'vision-exp' })

    await expect(service.resolveRoute()).rejects.toThrow('provider "absent" is not registered')
  })

  it('selects the first model advertising image input when unconfigured', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(TEXT, [textModel(), visionModel('second')]))
    const service = new LlmImageUnderstanding(ctx)

    await expect(service.resolveRoute()).resolves.toMatchObject({ provider: 'vision', model: 'second' })
  })

  it('reports no route when no model accepts images', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(TEXT, [textModel()]))
    const service = new LlmImageUnderstanding(ctx)

    await expect(service.resolveRoute()).resolves.toBeUndefined()
  })
})

describe('LlmImageUnderstanding.describe', () => {
  it('returns an index-aligned description per reference', async () => {
    const ctx = await llmContext()
    const adapter = new ScriptedAdapter(TEXT, [visionModel()])
    ctx.llm.registerAdapter(['vision'], adapter)
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })

    const results = await service.describe([ref('a'.repeat(64)), ref('b'.repeat(64))])

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      text: 'A red traffic light.',
      source: { provider: 'vision', model: 'vision-exp', instruction: DEFAULT_INSTRUCTION },
    })
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.purpose).toBe('image-understanding')
    expect(adapter.requests[0]?.maxTokens).toBe(512)
    expect(adapter.requests[0]?.messages[0]?.content[0]).toEqual({ type: 'image', attachment: ref('a'.repeat(64)) })
  })

  it('stamps the owning session id on the understanding call', async () => {
    const ctx = await llmContext()
    const adapter = new ScriptedAdapter(TEXT, [visionModel()])
    ctx.llm.registerAdapter(['vision'], adapter)
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })
    const sessionId = 'session-7' as unknown as NonNullable<GenerateOptions['sessionId']>

    await service.describe([ref('c'.repeat(64))], undefined, sessionId)

    expect(adapter.requests[0]?.sessionId).toBe(sessionId)
  })

  it('defaults the request-image policy to one megapixel and one MiB', async () => {
    const ctx = await llmContext()
    const adapter = new ScriptedAdapter(TEXT, [visionModel()])
    ctx.llm.registerAdapter(['vision'], adapter)
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })

    await service.describe([ref('k'.repeat(64))])

    expect(adapter.requests[0]?.requestImagePolicy).toEqual({
      maxPixels: 1024 * 1024,
      maxBytes: 1024 * 1024,
    })
  })

  it('sends the configured request-image policy on the understanding call', async () => {
    const ctx = await llmContext()
    const adapter = new ScriptedAdapter(TEXT, [visionModel()])
    ctx.llm.registerAdapter(['vision'], adapter)
    const service = new LlmImageUnderstanding(ctx, {
      provider: 'vision',
      model: 'vision-exp',
      requestImagePixelBudget: 2048 * 2048,
      requestImageMaxBytes: 512 * 1024,
    })

    await service.describe([ref('l'.repeat(64))])

    expect(adapter.requests[0]?.requestImagePolicy).toEqual({
      maxPixels: 2048 * 2048,
      maxBytes: 512 * 1024,
    })
  })

  it('serves a repeat reference from the cache without another call', async () => {
    const ctx = await llmContext()
    const adapter = new ScriptedAdapter(TEXT, [visionModel()])
    ctx.llm.registerAdapter(['vision'], adapter)
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })
    const target = ref('c'.repeat(64))

    await service.describe([target])
    await service.describe([target])

    expect(adapter.requests).toHaveLength(1)
  })

  it('evicts the oldest entry when the cache bound is exceeded', async () => {
    const ctx = await llmContext()
    const adapter = new ScriptedAdapter(TEXT, [visionModel()])
    ctx.llm.registerAdapter(['vision'], adapter)
    const service = new LlmImageUnderstanding(ctx, {
      provider: 'vision',
      model: 'vision-exp',
      maxCacheEntries: 1,
    })
    const first = ref('d'.repeat(64))
    const second = ref('e'.repeat(64))

    await service.describe([first])
    await service.describe([second])
    await service.describe([first])

    expect(adapter.requests).toHaveLength(3)
  })

  it('truncates a long description at a code-point boundary', async () => {
    const ctx = await llmContext()
    const long = 'x'.repeat(40) + '\u{1F600}'
    const adapter = new ScriptedAdapter([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: long },
      { type: 'finish', reason: { kind: 'stop' } },
    ], [visionModel()])
    ctx.llm.registerAdapter(['vision'], adapter)
    const service = new LlmImageUnderstanding(ctx, {
      provider: 'vision',
      model: 'vision-exp',
      maxDescriptionChars: 3,
    })

    const [result] = await service.describe([ref('f'.repeat(64))])

    expect(result?.text).toBe('xxx')
  })

  it('degrades to no description when the model returns no text', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(BLANK, [visionModel()]))
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })

    await expect(service.describe([ref('1'.repeat(64))])).resolves.toEqual([undefined])
  })

  it('degrades to no description when the call finishes with an error', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(FAILED, [visionModel()]))
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })

    await expect(service.describe([ref('2'.repeat(64))])).resolves.toEqual([undefined])
  })

  it('degrades to no description when the call finishes aborted', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(ABORTED, [visionModel()]))
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })

    await expect(service.describe([ref('g'.repeat(64))])).resolves.toEqual([undefined])
  })

  it('degrades to no description when the call rejects with a non-Error', async () => {
    const ctx = await llmContext()
    const throwing = new class extends ScriptedAdapter {
      override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw 'bare string failure'
      }
    }(TEXT, [visionModel()])
    ctx.llm.registerAdapter(['vision'], throwing)
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })

    await expect(service.describe([ref('h'.repeat(64))])).resolves.toEqual([undefined])
  })

  it('degrades to no description when the caller aborts with a non-Error reason', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(TEXT, [visionModel()]))
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })
    const controller = new AbortController()
    controller.abort('cancelled by caller')

    await expect(service.describe([ref('j'.repeat(64))], controller.signal)).resolves.toEqual([undefined])
  })

  it('degrades per image when one call throws', async () => {
    const ctx = await llmContext()
    let calls = 0
    const adapter = new ScriptedAdapter(TEXT, [visionModel()], () => {
      calls += 1
      if (calls === 1) throw new Error('transport down')
    })
    ctx.llm.registerAdapter(['vision'], adapter)
    const service = new LlmImageUnderstanding(ctx, { provider: 'vision', model: 'vision-exp' })

    const results = await service.describe([ref('3'.repeat(64)), ref('4'.repeat(64))])

    expect(results[0]).toBeUndefined()
    expect(results[1]).toEqual({
      text: 'A red traffic light.',
      source: { provider: 'vision', model: 'vision-exp', instruction: DEFAULT_INSTRUCTION },
    })
  })

  it('answers no descriptions when no route exists', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(TEXT, [textModel()]))
    const service = new LlmImageUnderstanding(ctx)

    await expect(service.describe([ref('5'.repeat(64))])).resolves.toEqual([undefined])
  })

  it('answers nothing for an empty batch', async () => {
    const ctx = await llmContext()
    const service = new LlmImageUnderstanding(ctx)

    await expect(service.describe([])).resolves.toEqual([])
  })
})

describe('routeExcludesImages', () => {
  it('treats an absent declaration as unknown rather than text-only', () => {
    expect(routeExcludesImages(undefined)).toBe(false)
    expect(routeExcludesImages(['text', 'image'])).toBe(false)
    expect(routeExcludesImages(['text'])).toBe(true)
  })
})

describe('describeForRoute', () => {
  it('skips understanding for a route that accepts images', async () => {
    const ctx = await llmContext()
    const adapter = new ScriptedAdapter(TEXT, [visionModel()])
    ctx.llm.registerAdapter(['vision'], adapter)
    await ctx.plugin(LlmImageUnderstanding)

    await expect(describeForRoute(ctx, [ref('6'.repeat(64))], ['text', 'image'])).resolves.toEqual([undefined])
    expect(adapter.requests).toHaveLength(0)
  })

  it('describes images for a text-only route', async () => {
    const ctx = await llmContext()
    const adapter = new ScriptedAdapter(TEXT, [visionModel()])
    ctx.llm.registerAdapter(['vision'], adapter)
    await ctx.plugin(LlmImageUnderstanding)

    await expect(describeForRoute(ctx, [ref('7'.repeat(64))], ['text'])).resolves.toEqual([{
      text: 'A red traffic light.',
      source: { provider: 'vision', model: 'vision-exp', instruction: DEFAULT_INSTRUCTION },
    }])
  })

  it('returns no descriptions when no describer service is mounted', async () => {
    const ctx = await llmContext()

    await expect(describeForRoute(ctx, [ref('8'.repeat(64))], ['text'])).resolves.toEqual([undefined])
  })

  it('degrades to no descriptions when the service rejects', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(TEXT, [visionModel()]))
    await ctx.plugin(LlmImageUnderstanding, { provider: 'absent', model: 'vision-exp' })

    await expect(describeForRoute(ctx, [ref('9'.repeat(64))], ['text'])).resolves.toEqual([undefined])
  })

  it('degrades to no descriptions when the mounted service throws a non-Error', async () => {
    const ctx = await llmContext()
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter(TEXT, [visionModel()]))
    ctx.provide('imageUnderstanding', {
      describe: () => Promise.reject('bare string failure'),
    } as never)

    await expect(describeForRoute(ctx, [ref('i'.repeat(64))], ['text'])).resolves.toEqual([undefined])
  })
})
