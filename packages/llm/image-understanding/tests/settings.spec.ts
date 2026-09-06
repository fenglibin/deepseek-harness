/** Image-understanding route layered over a real settings provider. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmImageUnderstanding, {
  DEFAULT_INSTRUCTION,
  IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE,
} from '../src/index.ts'
import type { ImageUnderstanding } from '../src/index.ts'

const TEXT: readonly StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'A red traffic light.' },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Adapter that records requests and answers with one fixed script. */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly models: readonly LlmModelInfo[] = []) {
    super()
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(_provider: string, model: string): Promise<LlmModelInfo> {
    const found = this.models.find(entry => entry.id === model)
    return Promise.resolve(found ?? { provider: 'vision', id: model, name: model, inputModalities: ['text'] })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield * TEXT
  }
}

function visionModel(id: string): LlmModelInfo {
  return { provider: 'vision', id, name: id, inputModalities: ['text', 'image'] }
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

/** The smallest real settings provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(config?: { provider: string; model: string }): Promise<{
  ctx: Context
  settingsFiber: Context['fiber']
  service: ImageUnderstanding
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(LlmImageUnderstanding, config ?? {})
  return { ctx, settingsFiber, service: ctx.imageUnderstanding }
}

describe('LlmImageUnderstanding settings layering', () => {
  it('reports the composition entry while the section stays empty', async () => {
    const bench = await boot({ provider: 'vision', model: 'vision-exp' })
    const service = bench.service as LlmImageUnderstanding
    expect(service.currentSelection()).toEqual({ provider: 'vision', model: 'vision-exp' })
    await bench.ctx.fiber.dispose()
  })

  it('reports no selection while both the entry and section stay empty', async () => {
    const bench = await boot()
    const service = bench.service as LlmImageUnderstanding
    expect(service.currentSelection()).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('resolves the user layer over the composition entry', async () => {
    const bench = await boot()
    await bench.ctx.settings.replace(IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE, {
      provider: 'vision',
      model: 'vision-exp',
    })
    expect((bench.service as LlmImageUnderstanding).currentSelection()).toEqual({
      provider: 'vision',
      model: 'vision-exp',
    })
    await bench.ctx.fiber.dispose()
  })

  it('resolves the user-selected route instead of discovering one', async () => {
    const bench = await boot()
    bench.ctx.llm.registerAdapter(['vision'], new ScriptedAdapter([visionModel('user-picked')]))
    await bench.ctx.settings.replace(IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE, {
      provider: 'vision',
      model: 'user-picked',
    })

    await expect(bench.service.resolveRoute()).resolves.toEqual({
      provider: 'vision',
      model: 'user-picked',
      instruction: DEFAULT_INSTRUCTION,
    })
    await bench.ctx.fiber.dispose()
  })

  it('re-resolves after the user selection changes', async () => {
    const bench = await boot()
    bench.ctx.llm.registerAdapter(['vision'], new ScriptedAdapter([
      visionModel('first'),
      visionModel('second'),
    ]))
    await bench.ctx.settings.replace(IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE, {
      provider: 'vision',
      model: 'first',
    })
    await expect(bench.service.resolveRoute()).resolves.toMatchObject({ model: 'first' })
    await bench.ctx.settings.replace(IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE, {
      provider: 'vision',
      model: 'second',
    })
    await expect(bench.service.resolveRoute()).resolves.toMatchObject({ model: 'second' })
    await bench.ctx.fiber.dispose()
  })

  it('uses the user-selected route for describing', async () => {
    const bench = await boot()
    bench.ctx.llm.registerAdapter(['vision'], new ScriptedAdapter([visionModel('user-picked')]))
    await bench.ctx.settings.replace(IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE, {
      provider: 'vision',
      model: 'user-picked',
    })

    const results = await bench.service.describe([ref('a'.repeat(64))])

    expect(results[0]).toEqual({
      text: 'A red traffic light.',
      source: { provider: 'vision', model: 'user-picked', instruction: DEFAULT_INSTRUCTION },
    })
    await bench.ctx.fiber.dispose()
  })

  it('rejects a hand-written section naming a provider without a model', async () => {
    const bench = await boot()
    await expect(bench.ctx.settings.replace(IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE, {
      provider: 'vision',
    })).rejects.toThrow(/provider and model must be set together/)
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot({ provider: 'vision', model: 'vision-exp' })
    await bench.ctx.settings.replace(IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE, {
      provider: 'vision',
      model: 'user-picked',
    })
    expect((bench.service as LlmImageUnderstanding).currentSelection()?.model).toBe('user-picked')
    await bench.settingsFiber.dispose()
    expect((bench.service as LlmImageUnderstanding).currentSelection()).toEqual({
      provider: 'vision',
      model: 'vision-exp',
    })
    await bench.ctx.fiber.dispose()
  })
})
