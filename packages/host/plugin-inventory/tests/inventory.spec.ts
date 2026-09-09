import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { PluginEntryId } from '../src/types.ts'
import PluginInventoryGateway from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function harness(): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  await ctx.plugin(PluginInventoryGateway)
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory }
}

describe('PluginInventoryGateway', () => {
  it('publishes one direct list method under the pluginInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'pluginInventory',
      namespace: 'pluginInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'describe', invocation: { kind: 'direct' } },
      { method: 'readme', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
    ])
  })

  it('enables and disables one entry, refusing ids that name nothing or a group', async () => {
    const { ctx, inventory } = await harness()
    const activeId = brandString<PluginEntryId>(await ctx.loader.create({ name: 'cordis:active' }))
    const groupId = brandString<PluginEntryId>(await ctx.loader.create({
      name: 'cordis:active',
      group: true,
    }))
    const enabledOf = async (): Promise<boolean | undefined> =>
      (await inventory.list()).entries.find(entry => entry.entryId === activeId)?.enabled

    expect(await enabledOf()).toBe(true)
    await inventory.setEnabled(activeId, false)
    expect(await enabledOf()).toBe(false)
    await inventory.setEnabled(activeId, true)
    expect(await enabledOf()).toBe(true)

    await expect(inventory.setEnabled(brandString<PluginEntryId>('absent'), true))
      .rejects.toMatchObject({ code: 'plugin-inventory/entry-not-found' })
    await expect(inventory.setEnabled(groupId, true))
      .rejects.toMatchObject({ code: 'plugin-inventory/entry-is-group' })
  })

  it('projects current non-group Loader entries without a second cache', async () => {
    const { ctx, inventory } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const snapshot = await inventory.list()
    // No agent-preset roster is composed, so the snapshot carries no presets.
    expect(snapshot.agentPresets).toBeUndefined()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        enabled: true,
        fiberPhase: 'active',
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        fiberPhase: 'pending',
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        enabled: false,
        fiberPhase: null,
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect((await inventory.list()).entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      enabled: false,
      fiberPhase: null,
    })

    await ctx.loader.remove(pendingId)
    expect((await inventory.list()).entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('describes one module on demand, resolved from the base, and lists no prose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-inventory-description-'))
    directories.push(dir)
    const pkgDir = join(dir, 'node_modules/documented')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'index.js'), 'module.exports = function documented() {}\n')
    await writeFile(join(pkgDir, 'package.json'), '{"name":"documented","version":"1.0.0","main":"index.js"}\n')
    await writeFile(join(pkgDir, 'README.zh.md'), '---\ndescription: "一句说明"\n---\n\n# documented\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(join(dir, 'anchor.js')).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.active = activePlugin
    await ctx.plugin(PluginInventoryGateway)
    const inventory = ctx.get('pluginInventory') as PluginInventoryGateway

    // A reader asks for exactly one module's description and README name.
    expect(await inventory.describe('documented')).toEqual({
      description: '一句说明',
      readme: 'README.zh.md',
    })
    // A builtin ships inside Cordis and publishes no README of its own.
    expect(await inventory.describe('cordis:active')).toEqual({})
  })

  it('reads the whole README on demand, with its frontmatter block removed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-inventory-readme-'))
    directories.push(dir)
    const pkgDir = join(dir, 'node_modules/documented')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'index.js'), 'module.exports = function documented() {}\n')
    await writeFile(join(pkgDir, 'package.json'), '{"name":"documented","version":"1.0.0","main":"index.js"}\n')
    await writeFile(join(pkgDir, 'README.zh.md'), '---\ndescription: "一句说明"\n---\n\n# documented\n\n正文。\n')

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(join(dir, 'anchor.js')).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.active = activePlugin
    await ctx.plugin(PluginInventoryGateway)
    const inventory = ctx.get('pluginInventory') as PluginInventoryGateway

    expect(await inventory.readme('documented')).toEqual({
      name: 'README.zh.md',
      text: '# documented\n\n正文。\n',
    })
    // A package no anchor installs, and a builtin, both publish nothing.
    expect(await inventory.readme('absent-package')).toBeUndefined()
    expect(await inventory.readme('cordis:active')).toBeUndefined()
  })

  it('carries each composed preset with root-fiber states mapped to phases', async () => {
    const { ctx, inventory } = await harness()
    ctx.provide('agentPresets', {
      compositionInventory: async () => [
        {
          id: 'standard',
          trust: 'system',
          name: '标准模式',
          isDefault: true,
          rows: [
            { entryId: 'alpha', moduleName: 'pkg-alpha', enabled: true, fiberState: FiberState.ACTIVE },
            { entryId: null, moduleName: 'pkg-file', enabled: 'conditional', condition: 'x' },
          ],
        },
        { id: 'damaged', trust: 'user', isDefault: false, broken: 'the composition file is missing', rows: [] },
      ],
    } as Partial<AgentPresets> as never)

    const snapshot = await inventory.list()
    expect(snapshot.agentPresets).toEqual([
      {
        id: 'standard',
        trust: 'system',
        name: '标准模式',
        isDefault: true,
        rows: [
          { entryId: 'alpha', moduleName: 'pkg-alpha', enabled: true, fiberPhase: 'active' },
          { entryId: null, moduleName: 'pkg-file', enabled: 'conditional', condition: 'x', fiberPhase: null },
        ],
      },
      { id: 'damaged', trust: 'user', isDefault: false, broken: 'the composition file is missing', rows: [] },
    ])
  })

  it('toggles a file-backed entry without writing its owning config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-inventory-write-'))
    directories.push(dir)
    const configPath = join(dir, 'cordis.yml')
    await writeFile(configPath, '- id: alpha\n  name: cordis:active\n')

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(join(dir, 'anchor.js')).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.active = activePlugin
    ctx.loader.builtins.include = Include
    await ctx.plugin(PluginInventoryGateway)
    const inventory = ctx.get('pluginInventory') as PluginInventoryGateway

    // Mount a file-backed include, then find the entry id it published.
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const alpha = (await inventory.list()).entries.find(entry => entry.moduleName === 'cordis:active')
    expect(alpha).toBeDefined()

    const before = await readFile(configPath, 'utf8')
    await inventory.setEnabled(alpha!.entryId, false)
    // The enablement is applied in memory only. The owning include schedules
    // its write-back on a 0ms timer, so a tick here would flush it if the
    // toggle still persisted through the tree.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await readFile(configPath, 'utf8')).toBe(before)
    // The running tree did observe the toggle.
    expect((await inventory.list()).entries.find(entry => entry.entryId === alpha!.entryId)?.enabled).toBe(false)
  })
})
