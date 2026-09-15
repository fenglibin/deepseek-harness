/**
 * The management surface over a real three-package composition.
 *
 * The unit suite mounts the gateway against a stubbed root list, which cannot
 * show whether a write lands where discovery actually looks. This suite mounts
 * `dsh-skill`, `dsh-skill-filesystem`, and `dsh-host-skill-manager` together
 * over a real directory, then asks the registry — not the manager — what
 * skills exist.
 *
 * The composition is mounted programmatically rather than booted from a
 * `cordis.yml`: the Loader imports each row through Node, whose resolution
 * reaches only built `lib/` artifacts, while this suite runs in the source
 * plane. Nothing else is stubbed — the real registry, the real filesystem
 * provider, and the real gateway all run.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import SkillManagerGateway from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One composition over a single custom skill root, isolated from the host's own roots. */
async function boot(): Promise<{
  readonly manager: SkillManagerGateway
  readonly skills: SkillRegistry
  readonly root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-composition-'))
  directories.push(root)

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SkillRegistry)
  // `includeDefaultRoots: false` keeps the developer's own project and user
  // skills out: this root is the whole catalog.
  await ctx.plugin(skillFilesystem, {
    includeDefaultRoots: false,
    customSkillDirs: [root],
    watch: false,
  })
  await ctx.plugin(SkillManagerGateway)

  return {
    manager: ctx.get('skillManager') as SkillManagerGateway,
    skills: ctx.get('skills') as SkillRegistry,
    root,
  }
}

/**
 * A second composition over a root that already exists.
 *
 * Discovery caches a completed catalog for its scope chain, and this suite
 * turns the watcher off, so a change made through a first composition is only
 * observable to a composition that never cached the old answer.
 * @param root - the skill root both compositions read.
 * @returns the new composition's gateway and registry over that root.
 */
async function reread(root: string): Promise<{
  readonly manager: SkillManagerGateway
  readonly skills: SkillRegistry
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(skillFilesystem, {
    includeDefaultRoots: false,
    customSkillDirs: [root],
    watch: false,
  })
  await ctx.plugin(SkillManagerGateway)
  return {
    manager: ctx.get('skillManager') as SkillManagerGateway,
    skills: ctx.get('skills') as SkillRegistry,
  }
}

describe('skill management over a real composition', () => {  it('offers the custom root discovery scans, and no other', async () => {
  const { manager, root } = await boot()
  const snapshot = await manager.list({})
  expect(snapshot.roots.map(view => view.path)).toEqual([root])
  expect(snapshot.roots[0]).toMatchObject({ source: 'custom', rank: 300, writable: true })
  expect(snapshot.roots[0]!.entries).toEqual([])
})

it('creates a skill the registry discovers at the workspace it was asked about', async () => {
  const { manager, skills, root } = await boot()

  const created = await manager.create({
    rootPath: root,
    name: 'created-here',
    description: 'Written by the management surface',
    invocation: { modelInvocable: true, userInvocable: true },
    content: 'Do the thing.',
    form: 'bundle',
  })
  expect(created.path).toBe(join(root, 'created-here', 'SKILL.md'))

  // The registry, not the manager, is the oracle: a write that landed
  // anywhere discovery does not scan leaves this empty.
  const summaries = await skills.list({ cwd: root })
  expect(summaries.map(summary => summary.name)).toEqual(['created-here'])
  expect(summaries[0]).toMatchObject({
    description: 'Written by the management surface',
    source: 'custom',
    invocation: { modelInvocable: true, userInvocable: true },
  })
})

it('carries the invocation policy the writer chose into discovery', async () => {
  const { manager, skills, root } = await boot()
  await manager.create({
    rootPath: root,
    name: 'user-only',
    description: 'Only a human may invoke this',
    invocation: { modelInvocable: false, userInvocable: true },
    content: '',
    form: 'flat',
  })

  const summaries = await skills.list({ cwd: root })
  expect(summaries[0]!.invocation).toEqual({ modelInvocable: false, userInvocable: true })
})

it('leaves nothing behind for discovery once an entry is removed', async () => {
  const { manager, root } = await boot()
  const created = await manager.create({
    rootPath: root, name: 'temporary', description: 'd', content: '', form: 'flat',
    invocation: { modelInvocable: true, userInvocable: true },
  })
  await manager.delete({ entryId: created.entryId })

  // A second composition reads the same root with an empty discovery cache;
  // this composition's cache would mask a removal the watcher is off for.
  const reloaded = await boot()
  const summaries = await reloaded.skills.list({ cwd: reloaded.root })
  expect(summaries).toEqual([])
  expect((await manager.list({})).roots[0]!.entries).toEqual([])
})

it('rewrites an existing entry so discovery reads the new text', async () => {
  const { manager, skills, root } = await boot()
  const created = await manager.create({
    rootPath: root,
    name: 'editable',
    description: 'Before',
    whenToUse: 'Before too',
    invocation: { modelInvocable: true, userInvocable: true },
    content: 'Old body.',
    form: 'flat',
  })

  await manager.update({
    entryId: created.entryId,
    description: 'After',
    invocation: { modelInvocable: true, userInvocable: true },
    content: 'New body.',
  })

  const summaries = await skills.list({ cwd: root })
  expect(summaries[0]!.description).toBe('After')
  expect(summaries[0]!.whenToUse).toBeUndefined()
  expect(await readFile(created.path, 'utf8')).toContain('New body.')
})

it('takes a disabled entry out of discovery and puts it back', async () => {
  const { manager, root } = await boot()
  const created = await manager.create({
    rootPath: root,
    name: 'parkable',
    description: 'Parked and restored',
    invocation: { modelInvocable: true, userInvocable: true },
    content: 'Body.',
    form: 'bundle',
  })

  await manager.setEnabled({ entryId: created.entryId, enabled: false })

  // The registry is the oracle again: a parked entry left inside the scanned
  // set would still be listed here.
  const parked = await reread(root)
  expect(await parked.skills.list({ cwd: root })).toEqual([])
  const listed = (await parked.manager.list({})).roots[0]!.entries
  expect(listed.map(entry => [entry.name, entry.enabled])).toEqual([['parkable', false]])

  await parked.manager.setEnabled({ entryId: listed[0]!.entryId, enabled: true })
  const restored = await reread(root)
  expect((await restored.skills.list({ cwd: root })).map(summary => summary.name)).toEqual(['parkable'])
})
})
