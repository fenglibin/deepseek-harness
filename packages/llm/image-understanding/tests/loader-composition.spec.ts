import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import * as imageUnderstanding from '../src/index.ts'
import { describeForRoute } from '../src/consumer.ts'

const VISION: LlmModelInfo = {
  provider: 'vision',
  id: 'vision-model',
  name: 'Vision',
  inputModalities: ['text', 'image'],
}

/** Adapter registered by the test composition; it answers with one fixed description. */
class VisionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([VISION])
  }

  override resolveModel(): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(VISION)
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'A red traffic light.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const shared = new VisionAdapter()

/** Function plugin that registers the vision provider route the Loader composition needs. */
export const visionAdapterPlugin = {
  name: 'test-vision-adapter',
  inject: ['llm'],
  apply: (ctx: Context): void => {
    ctx.llm.registerAdapter(['vision'], shared)
  },
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

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('image understanding real Loader composition', () => {
  it('boots cordis.yml and describes an image for a text-only route', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-image-understanding-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@test/vision-adapter'",
      "- name: '@deepseek-ai/dsh-image-understanding'",
      '  config:',
      '    provider: vision',
      '    model: vision-model',
      "    instruction: 'Describe it.'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@test/vision-adapter', visionAdapterPlugin],
      ['@deepseek-ai/dsh-image-understanding', imageUnderstanding],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const service = context.get('imageUnderstanding')
    if (service === undefined) throw new Error('Loader composition did not provide imageUnderstanding')

    const results = await describeForRoute(context, [ref('a'.repeat(64))], ['text'])
    expect(results).toEqual([{
      text: 'A red traffic light.',
      source: { provider: 'vision', model: 'vision-model', instruction: 'Describe it.' },
    }])
    expect(shared.requests).toHaveLength(1)
    expect(shared.requests[0]?.purpose).toBe('image-understanding')
    expect(shared.requests[0]?.messages[0]?.content).toEqual([
      { type: 'image', attachment: ref('a'.repeat(64)) },
      { type: 'text', text: 'Describe it.' },
    ])
  })
})
