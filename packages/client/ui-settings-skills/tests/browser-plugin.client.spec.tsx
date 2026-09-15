// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

/** One refused Remote result, the shape the gateway returns. */
function refused(code: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message: 'nope' } }
}

/** The Remote methods the section's injected face calls. */
interface Remotes {
  list: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
  listFiles: ReturnType<typeof vi.fn>
  readFile: ReturnType<typeof vi.fn>
  writeFile: ReturnType<typeof vi.fn>
  previewImport: ReturnType<typeof vi.fn>
  previewUpload: ReturnType<typeof vi.fn>
  commitImport: ReturnType<typeof vi.fn>
}

/** A client Context carrying the slots, locale, and Remote faces apply needs. */
async function bench(remotes?: Partial<Remotes>): Promise<{ ctx: Context; slots: SlotRegistry; remotes: Remotes }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)

  const all: Remotes = {
    list: vi.fn().mockResolvedValue({ ok: true, value: { roots: [] } }),
    delete: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    setEnabled: vi.fn().mockResolvedValue({ ok: true, value: { name: 'demo' } }),
    listFiles: vi.fn().mockResolvedValue({ ok: true, value: { files: [] } }),
    readFile: vi.fn().mockResolvedValue({ ok: true, value: { path: 'SKILL.md', text: '', editable: true } }),
    writeFile: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    previewImport: vi.fn().mockResolvedValue({ ok: true, value: { previewId: 'p1' } }),
    previewUpload: vi.fn().mockResolvedValue({ ok: true, value: { previewId: 'p1' } }),
    commitImport: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    ...remotes,
  }
  ctx.provide('remote.skillAdmin', all)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, remotes: all }
}

/** Mount the plugin and resolve the face it injected into its registered entry. */
async function faceOf(ctx: Context, slots: SlotRegistry): Promise<Record<string, unknown>> {
  slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  await ctx.plugin({ inject: [...inject], apply }).await()
  const entry = slots.entries('settings.section').find(candidate => candidate.options.id === 'skills')
  expect(entry).toBeDefined()
  return (entry!.inject as () => Record<string, unknown>)()
}

describe('ui-settings-skills browser plugin', () => {
  it('declares only the services the section contribution uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.skillAdmin'])
  })

  it('registers the localized section and its dictionaries', async () => {
    const { ctx, slots } = await bench()
    slots.register({
      name: 'root',
      children: { 'settings.section': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const entry = slots.entries('settings.section').find(candidate => candidate.options.id === 'skills')
    expect(entry).toBeDefined()
    expect(entry!.options.order).toBe(17)
    expect(entry!.locale).toBe(NS)
    expect((entry!.options.label as () => string)()).toBe(zh.nav)
    // The plugin's own dictionary: read back through the locale's bind once the
    // active locale is the one it registered, because a missing namespace
    // falls back to echoing the key.
    const locale = ctx.get('locale') as LocaleRuntime
    locale.setLocale('zh')
    expect(locale.bind(NS)('nav')).toBe(zh.nav)
  })

  it('forwards a workspace selection and omits it when none is made', async () => {
    const { ctx, slots, remotes } = await bench()
    const face = await faceOf(ctx, slots)
    await (face.list as (root?: string) => Promise<unknown>)('/work/app')
    expect(remotes.list).toHaveBeenCalledWith({ projectRoot: '/work/app' })
    await (face.list as (root?: string) => Promise<unknown>)()
    expect(remotes.list).toHaveBeenLastCalledWith({})
  })

  it('removes and toggles through the Remote', async () => {
    const { ctx, slots, remotes } = await bench()
    const face = await faceOf(ctx, slots)

    await (face.remove as (id: string, root?: string) => Promise<unknown>)('/root/demo.md', '/work/app')
    await (face.setEnabled as (id: string, on: boolean, root?: string) => Promise<unknown>)('/root/demo.md', false)

    expect(remotes.delete).toHaveBeenCalledWith({
      entryId: '/root/demo.md',
      projectRoot: '/work/app',
    })
    expect(remotes.setEnabled).toHaveBeenCalledWith({ entryId: '/root/demo.md', enabled: false })
  })

  it('lists, reads, and writes entry files through the Remote', async () => {
    const { ctx, slots, remotes } = await bench()
    const face = await faceOf(ctx, slots)

    await (face.listFiles as (id: string, root?: string) => Promise<unknown>)('/root/demo/SKILL.md', '/work/app')
    await (face.readFile as (id: string, path: string) => Promise<unknown>)('/root/demo/SKILL.md', 'SKILL.md')
    await (face.writeFile as (request: unknown) => Promise<unknown>)({
      entryId: '/root/demo/SKILL.md',
      path: 'SKILL.md',
      text: 'body',
    })

    expect(remotes.listFiles).toHaveBeenCalledWith({
      entryId: '/root/demo/SKILL.md',
      projectRoot: '/work/app',
    })
    expect(remotes.readFile).toHaveBeenCalledWith({ entryId: '/root/demo/SKILL.md', path: 'SKILL.md' })
    expect(remotes.writeFile).toHaveBeenCalledWith({
      entryId: '/root/demo/SKILL.md',
      path: 'SKILL.md',
      text: 'body',
    })
  })

  it('previews both import arms and commits the approved one', async () => {
    const { ctx, slots, remotes } = await bench()
    const face = await faceOf(ctx, slots)
    await (face.previewImport as (request: unknown) => Promise<unknown>)({ source: 'o/r' })
    await (face.previewUpload as (request: unknown) => Promise<unknown>)({ fileName: 'a.zip', data: 'UEsDBA==' })
    await (face.commitImport as (id: string) => Promise<unknown>)('p1')
    expect(remotes.previewImport).toHaveBeenCalledWith({ source: 'o/r' })
    expect(remotes.previewUpload).toHaveBeenCalledWith({ fileName: 'a.zip', data: 'UEsDBA==' })
    expect(remotes.commitImport).toHaveBeenCalledWith({ previewId: 'p1' })
  })

  it('rejects with the Remote code when a call is refused', async () => {
    const { ctx, slots } = await bench({
      list: vi.fn().mockResolvedValue(refused('skill-admin/io-failed')),
      delete: vi.fn().mockResolvedValue(refused('skill-admin/root-not-writable')),
      setEnabled: vi.fn().mockResolvedValue(refused('skill-admin/entry-exists')),
      readFile: vi.fn().mockResolvedValue(refused('skill-admin/file-not-found')),
      writeFile: vi.fn().mockResolvedValue(refused('skill-admin/invalid-frontmatter')),
      previewUpload: vi.fn().mockResolvedValue(refused('skill-admin/upload-invalid')),
      previewImport: vi.fn().mockResolvedValue(refused('skill-admin/import-no-skill')),
      commitImport: vi.fn().mockResolvedValue(refused('skill-admin/import-expired')),
    })
    const face = await faceOf(ctx, slots)

    await expect((face.list as () => Promise<unknown>)()).rejects.toThrow(/io-failed/)
    await expect((face.remove as (id: string) => Promise<unknown>)('x')).rejects.toThrow(/root-not-writable/)
    await expect((face.setEnabled as (id: string, on: boolean) => Promise<unknown>)('x', true))
      .rejects.toThrow(/entry-exists/)
    await expect((face.readFile as (id: string, path: string) => Promise<unknown>)('x', 'y'))
      .rejects.toThrow(/file-not-found/)
    await expect((face.writeFile as (request: unknown) => Promise<unknown>)({}))
      .rejects.toThrow(/invalid-frontmatter/)
    await expect((face.previewUpload as (request: unknown) => Promise<unknown>)({}))
      .rejects.toThrow(/upload-invalid/)
    await expect((face.previewImport as (request: unknown) => Promise<unknown>)({}))
      .rejects.toThrow(/import-no-skill/)
    await expect((face.commitImport as (id: string) => Promise<unknown>)('p1'))
      .rejects.toThrow(/import-expired/)
  })
})
