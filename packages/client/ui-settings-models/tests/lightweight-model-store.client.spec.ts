/** Lightweight-model store: catalog join, staged draft, and the revision fence around one write. */
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
  lightweightModelCandidates, lightweightModelKey, LightweightModelStore,
} from '../src/client/lightweight-model-store.ts'
import type { LightweightModelSettings } from '../src/client/lightweight-model-store.ts'

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

/**
 * One namespace view, as the Host describe answers it. The schema is the
 * section's own wire schema: the default scope decoder resolves the value
 * against it, so a section that fails it reads as unanswered.
 * @param value - stored section.
 * @param revision - namespace revision fencing the next write.
 * @returns the namespace view.
 */
function view(value: unknown = { provider: '', model: '' }, revision = 3): SettingsNamespaceView {
  return {
    ns: 'lightweight-model',
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
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }] },
  ],
  failures: [],
}

const OPENAI = { provider: 'openai', model: 'gpt-4o-mini' }
const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-chat' }
const GHOST = { provider: 'ghost', model: 'ghost-1' }

/** The scripted wire: one describe answer, one catalog answer, one write. */
interface Wire {
  describe?: () => Promise<RemoteAnswer<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }>>
  catalog?: () => Promise<RemoteAnswer<ModelCatalog>>
  mutate?: () => Promise<RemoteAnswer<SettingsNamespaceView>>
}

/**
 * The store over a scripted wire whose settings mirror already answered.
 * @param wire - scripted Host answers.
 * @param persistence - client-selected Host persistence.
 * @returns the store, its mirror, and the wire mocks.
 */
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
  const scope = new SettingsScopeController<LightweightModelSettings>(
    wireFace,
    { namespace: 'lightweight-model' },
    mirror,
    persistence,
    schemaService,
  )
  const store = new LightweightModelStore(scope, wireFace)
  await mirror.load()
  return { store, mirror, scope, describe, modelCatalog, mutate }
}

describe('lightweightModelCandidates', () => {
  it('flattens the catalog and keeps a route it no longer advertises', () => {
    const candidates = lightweightModelCandidates(CATALOG.groups, [GHOST, DEEPSEEK])
    expect(candidates.map(candidate => candidate.key)).toEqual([
      lightweightModelKey(DEEPSEEK),
      lightweightModelKey(OPENAI),
      lightweightModelKey(GHOST),
    ])
    // A route the catalog dropped carries no adapter names, so it renders by
    // its own ids — and stays selectable, which is how it gets cleared.
    expect(candidates[2]).toEqual({
      ...GHOST, key: lightweightModelKey(GHOST), providerName: 'ghost', modelName: 'ghost-1',
    })
    expect(candidates[1]).toMatchObject({ providerName: 'OpenAI', modelName: 'GPT-4o mini' })
  })

  it('offers only the catalog when nothing is retained', () => {
    expect(lightweightModelCandidates([], []).length).toBe(0)
    expect(lightweightModelCandidates(CATALOG.groups, []).map(candidate => candidate.key)).toEqual([
      lightweightModelKey(DEEPSEEK),
      lightweightModelKey(OPENAI),
    ])
  })
})

describe('LightweightModelStore', () => {
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
    expect(state.selected).toBe(lightweightModelKey(OPENAI))
    expect(state.candidates.map(candidate => candidate.key)).toEqual([
      lightweightModelKey(DEEPSEEK),
      lightweightModelKey(OPENAI),
    ])
  })

  it('keeps a stored route the catalog dropped so it stays removable', async () => {
    const { store } = await build({
      describe: () => Promise.resolve(ok({
        writable: true, hasDocument: false, namespaces: [view(GHOST)],
      })),
    })
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.selected).toBe(lightweightModelKey(GHOST))
    expect(state.candidates.at(-1)).toMatchObject({ ...GHOST, providerName: 'ghost' })
  })

  it('saves a staged route as one revision-fenced mutation over both fields', async () => {
    const { store, mutate } = await build({
      mutate: () => Promise.resolve(ok(view(DEEPSEEK, 4))),
    })
    await store.load()
    store.select(lightweightModelKey(DEEPSEEK))
    expect(store.store.getSnapshot()).toMatchObject({
      dirty: true, selected: lightweightModelKey(DEEPSEEK),
    })
    await store.save()
    expect(mutate).toHaveBeenCalledWith(
      'lightweight-model',
      [
        { op: 'set', path: ['provider'], value: 'deepseek-official' },
        { op: 'set', path: ['model'], value: 'deepseek-chat' },
      ],
      3,
    )
    expect(store.store.getSnapshot()).toMatchObject({
      dirty: false, failed: false, saving: false, selected: lightweightModelKey(DEEPSEEK),
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
      'lightweight-model',
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
    store.select(lightweightModelKey(OPENAI))
    expect(store.store.getSnapshot().dirty).toBe(false)
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('ignores an unknown key and an earlier save with nothing staged', async () => {
    const { store, mutate } = await build()
    await store.load()
    store.select(lightweightModelKey(GHOST))
    expect(store.store.getSnapshot().dirty).toBe(false)
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('drops the staged choice on discard', async () => {
    const { store } = await build()
    await store.load()
    store.select(lightweightModelKey(DEEPSEEK))
    store.discard()
    expect(store.store.getSnapshot()).toMatchObject({ dirty: false, selected: undefined })
  })

  it('refuses a save whose revision moved on since the draft began', async () => {
    const { store, mirror, mutate } = await build()
    await store.load()
    store.select(lightweightModelKey(DEEPSEEK))
    // Somewhere else committed first: the fence the draft took is stale.
    mirror.acceptView(view(OPENAI, 9))
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
    expect(store.store.getSnapshot()).toMatchObject({ failed: true, dirty: true })
  })

  it('reports a write the Host did not land', async () => {
    const { store } = await build({ mutate: () => Promise.resolve(ok(view({ provider: '', model: '' }, 4))) })
    await store.load()
    store.select(lightweightModelKey(DEEPSEEK))
    await store.save()
    expect(store.store.getSnapshot()).toMatchObject({ failed: true, dirty: true, saving: false })
  })

  it('reports a write the Host refused', async () => {
    const { store, describe } = await build({ mutate: () => Promise.resolve(fail('settings are read-only')) })
    await store.load()
    store.select(lightweightModelKey(DEEPSEEK))
    await store.save()
    expect(store.store.getSnapshot()).toMatchObject({ failed: true, dirty: true, selected: lightweightModelKey(DEEPSEEK) })
    // A refused write reloads Host state rather than leaving the refusal to stand as fact.
    expect(describe).toHaveBeenCalledTimes(2)
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
    expect(store.store.getSnapshot().candidates).toHaveLength(2)
  })

  it('shares one in-flight catalog request', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { store, modelCatalog } = await build({ catalog: () => gate.then(() => ok(CATALOG)) })
    const first = store.load()
    store.retry()
    release?.()
    await first
    expect(modelCatalog).toHaveBeenCalledTimes(1)
  })

  it('serves a second load from the answer the first one fetched', async () => {
    const { store, modelCatalog } = await build()
    await store.load()
    await store.load()
    expect(modelCatalog).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot().catalogStatus).toBe('ready')
  })

  it('leaves an in-flight request alone when a refresh lands behind it', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { store, modelCatalog } = await build({ catalog: () => gate.then(() => ok(CATALOG)) })
    const pending = store.load()
    store.refresh()
    release?.()
    await pending
    expect(modelCatalog).toHaveBeenCalledTimes(1)
  })

  it('abandons a save still crossing the wire when the page disposes', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { store } = await build({ mutate: () => gate.then(() => ok(view(DEEPSEEK, 4))) })
    await store.load()
    store.select(lightweightModelKey(DEEPSEEK))
    const pending = store.save()
    store.dispose()
    release?.()
    await pending
    // The write's own settlement is dropped, so nothing claims it landed.
    expect(store.store.getSnapshot()).toMatchObject({ saving: true, dirty: true, failed: false })
  })

  it('refreshes a loaded catalog but never fetches one it never requested', async () => {
    const { store, modelCatalog } = await build()
    store.refresh()
    expect(modelCatalog).not.toHaveBeenCalled()
    await store.load()
    store.refresh()
    await vi.waitFor(() => { expect(modelCatalog).toHaveBeenCalledTimes(2) })
  })

  it('drops a catalog answer and a write settlement that land after disposal', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { store, modelCatalog } = await build({ catalog: () => gate.then(() => ok(CATALOG)) })
    const pending = store.load()
    store.dispose()
    release?.()
    await pending
    expect(modelCatalog).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot().catalogStatus).toBe('loading')
  })

  it('ignores every action once disposed', async () => {
    const { store, mutate } = await build()
    await store.load()
    store.dispose()
    store.select(lightweightModelKey(DEEPSEEK))
    store.clear()
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('keeps a remote browser read-only instead of claiming a save', async () => {
    const { store, mutate, modelCatalog, describe } = await build({}, 'memory')
    const state = store.store.getSnapshot()
    expect(state).toMatchObject({ available: false, writable: false })
    store.refresh()
    store.select(lightweightModelKey(DEEPSEEK))
    store.clear()
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
    expect(describe).not.toHaveBeenCalled()
    // The card gates its catalog request on `available`, so an unopened remote
    // page reaches no wire for a preference it cannot hold.
    expect(modelCatalog).not.toHaveBeenCalled()
    expect(store.store.getSnapshot()).toMatchObject({ dirty: false, failed: false })
  })

  it('refuses to stage while a save is crossing the wire', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { store } = await build({ mutate: () => gate.then(() => ok(view(DEEPSEEK, 4))) })
    await store.load()
    store.select(lightweightModelKey(DEEPSEEK))
    const pending = store.save()
    expect(store.store.getSnapshot().saving).toBe(true)
    // Neither the picker nor Discard may move the draft out from under the write.
    store.select(lightweightModelKey(OPENAI))
    store.discard()
    expect(store.store.getSnapshot().selected).toBe(lightweightModelKey(DEEPSEEK))
    release?.()
    await pending
    expect(store.store.getSnapshot()).toMatchObject({ saving: false, failed: false, dirty: false })
  })

  it('re-stages on top of an existing draft without retaking the fence', async () => {
    const { store, mutate } = await build({ mutate: () => Promise.resolve(ok(view(OPENAI, 4))) })
    await store.load()
    store.select(lightweightModelKey(DEEPSEEK))
    store.select(lightweightModelKey(OPENAI))
    expect(store.store.getSnapshot().selected).toBe(lightweightModelKey(OPENAI))
    await store.save()
    expect(mutate).toHaveBeenCalledWith(
      'lightweight-model',
      [
        { op: 'set', path: ['provider'], value: 'openai' },
        { op: 'set', path: ['model'], value: 'gpt-4o-mini' },
      ],
      3,
    )
  })

  it('never stages while the Host document refuses writes', async () => {
    const { store, mutate } = await build({
      describe: () => Promise.resolve(ok({
        writable: false, hasDocument: false, namespaces: [view()],
      })),
    })
    await store.load()
    store.select(lightweightModelKey(DEEPSEEK))
    store.clear()
    await store.save()
    expect(mutate).not.toHaveBeenCalled()
    expect(store.store.getSnapshot()).toMatchObject({ writable: false, dirty: false, selected: undefined })
  })
})
