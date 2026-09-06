/** Image-understanding store: catalog join, staged draft, and the revision fence around one write. */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import type {
  ModelCatalog, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/src/client/schema.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsScopeController } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-scope.ts'
import {
  imageUnderstandingCandidates, imageUnderstandingKey, ImageUnderstandingModelStore,
} from '../src/client/image-understanding-model-store.ts'
import type { ImageUnderstandingSettings } from '../src/client/image-understanding-model-store.ts'

const schemaService = new SettingsSchemaService(new Context())

const SECTION_SCHEMA = Schema.object({
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
}).toJSON()

/** The settings answers over the Remote carrier, which has no envelope. */
type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteError }
function ok<T>(value: T): RemoteAnswer<T> {
  return { ok: true, value }
}
function fail(message: string): RemoteAnswer<never> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

/** One namespace view, as the Host describe answers it. */
function view(value: unknown = { provider: '', model: '' }, revision = 3): SettingsNamespaceView {
  return {
    ns: 'image-understanding',
    schema: JSON.parse(JSON.stringify(SECTION_SCHEMA)) as JsonValue,
    value,
    applies: 'live',
    secrets: [],
    revision,
  } as SettingsNamespaceView
}

const CATALOG: ModelCatalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-chat' },
  routableProviders: ['deepseek-official', 'openai'],
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-vl', name: 'DeepSeek VL' }] },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
  ],
  failures: [],
}

const OPENAI = { provider: 'openai', model: 'gpt-4o' }
const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-vl' }
const GHOST = { provider: 'ghost', model: 'ghost-vl' }

/** The scripted wire: one describe answer, one catalog answer, one write. */
interface Wire {
  describe?: () => Promise<RemoteAnswer<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }>>
  catalog?: () => Promise<RemoteAnswer<ModelCatalog>>
  mutate?: () => Promise<RemoteAnswer<SettingsNamespaceView>>
}

/** The store over a scripted wire whose settings mirror already answered. */
async function build(wire: Wire = {}, persistence: 'host' | 'memory' = 'host') {
  const describe = vi.fn(wire.describe ?? (() => Promise.resolve(ok({
    writable: true,
    hasDocument: false,
    namespaces: [view()],
  }))))
  const modelCatalog = vi.fn(wire.catalog ?? (() => Promise.resolve(ok(CATALOG))))
  const mutate = vi.fn(wire.mutate ?? (() => Promise.resolve(ok(view()))))
  const wireFace = { remote: { settings: { describe, mutate }, session: { modelCatalog } } } as never
  const mirror = new SettingsDescribeMirror(wireFace, persistence)
  const scope = new SettingsScopeController<ImageUnderstandingSettings>(
    wireFace,
    { namespace: 'image-understanding' },
    mirror,
    persistence,
    schemaService,
  )
  const store = new ImageUnderstandingModelStore(scope, wireFace)
  await mirror.load()
  return { store, mirror, scope, describe, modelCatalog, mutate }
}

describe('imageUnderstandingCandidates', () => {
  it('flattens the catalog and keeps a route it no longer advertises', () => {
    const candidates = imageUnderstandingCandidates(CATALOG.groups, [GHOST, DEEPSEEK])
    expect(candidates.map(candidate => candidate.key)).toEqual([
      imageUnderstandingKey(DEEPSEEK),
      imageUnderstandingKey(OPENAI),
      imageUnderstandingKey(GHOST),
    ])
    expect(candidates[2]).toEqual({
      ...GHOST, key: imageUnderstandingKey(GHOST), providerName: 'ghost', modelName: 'ghost-vl',
    })
    expect(candidates[1]).toMatchObject({ providerName: 'OpenAI', modelName: 'GPT-4o' })
  })
})

describe('ImageUnderstandingModelStore', () => {
  it('joins the catalog with the stored route', async () => {
    const { store } = await build({
      describe: () => Promise.resolve(ok({
        writable: true, hasDocument: false, namespaces: [view(OPENAI)],
      })),
    })
    await store.load()
    const state = store.store.getSnapshot()
    expect(state).toMatchObject({
      available: true, writable: true, catalogStatus: 'ready', dirty: false, failed: false, saving: false,
    })
    expect(state.selected).toBe(imageUnderstandingKey(OPENAI))
  })

  it('saves a staged route into the image-understanding namespace', async () => {
    const { store, mutate } = await build({
      mutate: () => Promise.resolve(ok(view(DEEPSEEK, 4))),
    })
    await store.load()
    store.select(imageUnderstandingKey(DEEPSEEK))
    await store.save()
    expect(mutate).toHaveBeenCalledWith(
      'image-understanding',
      [
        { op: 'set', path: ['provider'], value: 'deepseek-official' },
        { op: 'set', path: ['model'], value: 'deepseek-vl' },
      ],
      3,
    )
    expect(store.store.getSnapshot()).toMatchObject({
      dirty: false, failed: false, selected: imageUnderstandingKey(DEEPSEEK),
    })
  })

  it('clears a stored route by writing both fields empty', async () => {
    const { store, mutate } = await build({
      describe: () => Promise.resolve(ok({
        writable: true, hasDocument: false, namespaces: [view(OPENAI)],
      })),
      mutate: () => Promise.resolve(ok(view({ provider: '', model: '' }, 4))),
    })
    await store.load()
    store.clear()
    expect(store.store.getSnapshot()).toMatchObject({ dirty: true, selected: undefined })
    await store.save()
    expect(mutate).toHaveBeenCalledWith(
      'image-understanding',
      [
        { op: 'set', path: ['provider'], value: '' },
        { op: 'set', path: ['model'], value: '' },
      ],
      3,
    )
  })

  it('ignores a staged choice equal to the stored one', async () => {
    const { store, mutate } = await build({
      describe: () => Promise.resolve(ok({
        writable: true, hasDocument: false, namespaces: [view(OPENAI)],
      })),
    })
    await store.load()
    store.select(imageUnderstandingKey(OPENAI))
    expect(store.store.getSnapshot().dirty).toBe(false)
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('refuses a save whose revision moved on since the draft began', async () => {
    const { store, mirror, mutate } = await build()
    await store.load()
    store.select(imageUnderstandingKey(DEEPSEEK))
    mirror.acceptView(view(OPENAI, 9))
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
    expect(store.store.getSnapshot()).toMatchObject({ failed: true, dirty: true })
  })

  it('reports a failed catalog load and reloads on retry', async () => {
    let attempt = 0
    const { store, modelCatalog } = await build({
      catalog: () => {
        attempt += 1
        return Promise.resolve(attempt === 1 ? fail('catalog down') : ok(CATALOG))
      },
    })
    await store.load()
    expect(store.store.getSnapshot().catalogStatus).toBe('error')
    store.retry()
    await vi.waitFor(() => { expect(store.store.getSnapshot().catalogStatus).toBe('ready') })
    expect(modelCatalog).toHaveBeenCalledTimes(2)
  })

  it('ignores every action once disposed', async () => {
    const { store, mutate } = await build()
    await store.load()
    store.dispose()
    store.select(imageUnderstandingKey(DEEPSEEK))
    store.clear()
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('keeps a remote browser read-only instead of claiming a save', async () => {
    const { store, mutate, modelCatalog, describe } = await build({}, 'memory')
    expect(store.store.getSnapshot()).toMatchObject({ available: false, writable: false })
    store.select(imageUnderstandingKey(DEEPSEEK))
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
    expect(describe).not.toHaveBeenCalled()
    expect(modelCatalog).not.toHaveBeenCalled()
  })
})
