import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SkillRootInfo } from '@deepseek-ai/dsh-skill-filesystem'
import SkillManagerGateway from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One writable user root under a fresh temporary directory. */
async function scratchRoot(source = 'user-dsh', rank = 400): Promise<{ dir: string; root: SkillRootInfo }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-'))
  directories.push(dir)
  return { dir, root: { path: dir, source, rank, readOnly: false } }
}

/** Mount the gateway over a fixed root list. */
async function harness(roots: readonly SkillRootInfo[]): Promise<SkillManagerGateway> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('skillRoots', { list: async () => roots })
  await ctx.plugin(SkillManagerGateway)
  return ctx.get('skillManager') as SkillManagerGateway
}

/** Write one skill file, creating its parent directory. */
async function writeSkill(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

describe('SkillManagerGateway wiring', () => {
  it('binds the skillManager service to the skillAdmin wire namespace', async () => {
    const { root } = await scratchRoot()
    const manager = await harness([root])
    expect(manager.typertRemote).toMatchObject({ serviceKey: 'skillManager', namespace: 'skillAdmin' })
  })
})

describe('list', () => {
  it('reads bundles, flat files, and unusable files from one root', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'bundle-skill', 'SKILL.md'), [
      '---', 'name: bundle-skill', 'description: From a bundle', '---', '', 'Body.', '',
    ].join('\n'))
    await writeSkill(join(dir, 'flat-skill.md'), [
      '---', 'name: flat-skill', 'description: From a flat file', 'user-invocable: false', '---', '', 'Body.', '',
    ].join('\n'))
    await writeSkill(join(dir, 'broken.md'), 'no frontmatter at all\n')
    await writeSkill(join(dir, 'notes.txt'), 'ignored\n')

    const snapshot = await (await harness([root])).list({})
    expect(snapshot.roots).toHaveLength(1)
    const entries = snapshot.roots[0]!.entries
    expect(entries.map(entry => entry.name)).toEqual(['broken', 'bundle-skill', 'flat-skill'])

    const bundle = entries.find(entry => entry.name === 'bundle-skill')!
    expect(bundle.form).toBe('bundle')
    expect(bundle.path).toBe(join(dir, 'bundle-skill', 'SKILL.md'))
    expect(bundle.directory).toBe(join(dir, 'bundle-skill'))
    expect(bundle.invalid).toBeUndefined()

    const flat = entries.find(entry => entry.name === 'flat-skill')!
    expect(flat.form).toBe('flat')
    expect(flat.invocation).toEqual({ modelInvocable: true, userInvocable: false })

    const broken = entries.find(entry => entry.name === 'broken')!
    expect(broken.invalid).toBe('missing YAML frontmatter')
    expect(broken.description).toBe('')
  })

  it('reports a root that does not exist as an empty root rather than failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-'))
    directories.push(dir)
    const root: SkillRootInfo = { path: join(dir, 'absent'), source: 'user-dsh', rank: 400, readOnly: false }
    const snapshot = await (await harness([root])).list({})
    expect(snapshot.roots[0]!.entries).toEqual([])
  })

  it('marks the lower-precedence duplicate of a name as shadowed', async () => {
    const winner = await scratchRoot('project-dsh', 100)
    const loser = await scratchRoot('user-dsh', 400)
    const text = ['---', 'name: shared', 'description: shared skill', '---', '', 'Body.', ''].join('\n')
    await writeSkill(join(winner.dir, 'shared.md'), text)
    await writeSkill(join(loser.dir, 'shared.md'), text)

    const snapshot = await (await harness([winner.root, loser.root])).list({})
    const [project, user] = snapshot.roots
    expect(project!.entries[0]!.shadowed).toBe(false)
    expect(user!.entries[0]!.shadowed).toBe(true)
  })

  it('does not let an unusable entry shadow a usable one of the same name', async () => {
    const winner = await scratchRoot('project-dsh', 100)
    const loser = await scratchRoot('user-dsh', 400)
    await writeSkill(join(winner.dir, 'shared.md'), 'no frontmatter\n')
    await writeSkill(join(loser.dir, 'shared.md'), [
      '---', 'name: shared', 'description: usable', '---', '', 'Body.', '',
    ].join('\n'))

    const snapshot = await (await harness([winner.root, loser.root])).list({})
    expect(snapshot.roots[1]!.entries[0]!.shadowed).toBe(false)
  })

  it('reports a read-only root and refuses writes into it', async () => {
    const { dir } = await scratchRoot()
    const root: SkillRootInfo = { path: dir, source: 'bundled', rank: 600, readOnly: true }
    const manager = await harness([root])
    const snapshot = await manager.list({})
    expect(snapshot.roots[0]).toMatchObject({ writable: false })
    expect(snapshot.roots[0]!.readOnlyReason).toBeDefined()
    await expect(manager.create({
      rootPath: dir, name: 'new-skill', description: 'd', content: '', form: 'flat',
      invocation: { modelInvocable: true, userInvocable: true },
    })).rejects.toMatchObject({ code: 'skill-admin/root-not-writable' })
  })
})

describe('read', () => {
  it('returns the verbatim file beside its parsed fields', async () => {
    const { dir, root } = await scratchRoot()
    const text = ['---', 'name: demo', 'description: A demo', 'whenToUse: When demoing', '---', '', 'Body.', ''].join('\n')
    await writeSkill(join(dir, 'demo.md'), text)
    const manager = await harness([root])
    const entry = (await manager.list({})).roots[0]!.entries[0]!
    const document = await manager.read({ entryId: entry.entryId })
    expect(document.raw).toBe(text)
    expect(document.content).toBe('Body.')
    expect(document.name).toBe('demo')
    expect(document.whenToUse).toBe('When demoing')
    expect(document.form).toBe('flat')
  })

  it('refuses a file it cannot address', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    await expect(manager.read({ entryId: join(dir, 'absent.md') as never }))
      .rejects.toMatchObject({ code: 'skill-admin/entry-not-found' })
  })

  it('refuses a file whose frontmatter block is unusable', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'broken.md'), 'no frontmatter\n')
    const manager = await harness([root])
    await expect(manager.read({ entryId: join(dir, 'broken.md') as never }))
      .rejects.toMatchObject({ code: 'skill-admin/invalid-frontmatter' })
  })
})

describe('create', () => {
  it('writes a directory bundle whose frontmatter discovery can read back', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    const created = await manager.create({
      rootPath: dir,
      name: 'new-skill',
      description: 'A new skill',
      whenToUse: 'When new',
      invocation: { modelInvocable: false, userInvocable: true },
      content: 'Do the thing.',
      form: 'bundle',
    })
    expect(created.path).toBe(join(dir, 'new-skill', 'SKILL.md'))
    expect(created.form).toBe('bundle')
    expect(created.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    const text = await readFile(created.path, 'utf8')
    expect(text).toBe([
      '---',
      'name: new-skill',
      'description: A new skill',
      'whenToUse: When new',
      'disable-model-invocation: true',
      'user-invocable: true',
      '---',
      '',
      'Do the thing.',
      '',
    ].join('\n'))
  })

  it('writes a flat file when asked for one', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    const created = await manager.create({
      rootPath: dir, name: 'flat-skill', description: 'd', content: '', form: 'flat',
      invocation: { modelInvocable: true, userInvocable: true },
    })
    expect(created.path).toBe(join(dir, 'flat-skill.md'))
    expect(created.form).toBe('flat')
  })

  it('rejects a name that is not kebab-case', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    await expect(manager.create({
      rootPath: dir, name: 'Not_Kebab', description: 'd', content: '', form: 'flat',
      invocation: { modelInvocable: true, userInvocable: true },
    })).rejects.toMatchObject({ code: 'skill-admin/invalid-name' })
  })

  it('rejects a root outside the scanned set', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    await expect(manager.create({
      rootPath: join(dir, 'elsewhere'), name: 'demo', description: 'd', content: '', form: 'flat',
      invocation: { modelInvocable: true, userInvocable: true },
    })).rejects.toMatchObject({ code: 'skill-admin/root-not-found' })
  })

  it('refuses to overwrite an entry that already occupies the name', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'taken.md'), '---\nname: taken\ndescription: t\n---\n')
    const manager = await harness([root])
    await expect(manager.create({
      rootPath: dir, name: 'taken', description: 'd', content: '', form: 'flat',
      invocation: { modelInvocable: true, userInvocable: true },
    })).rejects.toMatchObject({ code: 'skill-admin/entry-exists' })
  })
})

describe('update', () => {
  it('rewrites the named fields while keeping comments and unknown keys', async () => {
    const { dir, root } = await scratchRoot()
    const path = join(dir, 'demo.md')
    await writeSkill(path, [
      '---',
      '# hand-written note',
      'name: demo',
      'description: Before',
      'whenToUse: Before too',
      'custom-key: keep me',
      '---',
      '',
      'Old body.',
      '',
    ].join('\n'))
    const manager = await harness([root])
    const entry = (await manager.list({})).roots[0]!.entries[0]!

    await manager.update({
      entryId: entry.entryId,
      description: 'After',
      invocation: { modelInvocable: false, userInvocable: false },
      content: 'New body.',
    })

    const text = await readFile(path, 'utf8')
    expect(text).toContain('# hand-written note')
    expect(text).toContain('custom-key: keep me')
    expect(text).toContain('description: After')
    expect(text).toContain('disable-model-invocation: true')
    expect(text).toContain('user-invocable: false')
    expect(text).not.toContain('whenToUse')
    expect(text.endsWith('---\n\nNew body.\n')).toBe(true)
  })

  it('refuses an entry no scanned root contains', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    await expect(manager.update({
      entryId: join(dir, 'absent.md') as never,
      description: 'd',
      invocation: { modelInvocable: true, userInvocable: true },
      content: '',
    })).rejects.toMatchObject({ code: 'skill-admin/entry-not-found' })
  })
})

describe('update and remove outside every scanned root', () => {
  it('refuses an update for a path no scanned root contains', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    // Outside the root entirely, so ownership itself is unresolvable — a
    // different failure from an absent file inside a known root.
    await expect(manager.update({
      entryId: join(dir, '..', 'outside.md') as never,
      description: 'After',
      invocation: { modelInvocable: true, userInvocable: true },
      content: '',
    })).rejects.toMatchObject({ code: 'skill-admin/entry-not-found' })
  })
})

describe('read with incomplete frontmatter', () => {
  it('falls back to the basename and an empty description', async () => {
    const { dir, root } = await scratchRoot()
    const path = join(dir, 'fallback.md')
    await writeSkill(path, '---\nwhenToUse: Only a hint\n---\n\nBody.\n')
    const document = await (await harness([root])).read({ entryId: path as never })
    expect(document.name).toBe('fallback')
    expect(document.description).toBe('')
    expect(document.whenToUse).toBe('Only a hint')
    expect(document.content).toBe('Body.')
  })
})

describe('scan shapes', () => {
  it('skips dotted entries and non-markdown files, and reads a bundle', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, '.hidden.md'), '---\nname: hidden\ndescription: d\n---\n')
    await writeSkill(join(dir, 'notes.txt'), 'ignored\n')
    await writeSkill(join(dir, 'a-bundle', 'SKILL.md'), '---\nname: a-bundle\ndescription: d\n---\n')
    const entries = (await (await harness([root])).list({})).roots[0]!.entries
    expect(entries.map(entry => entry.name)).toEqual(['a-bundle'])
  })

  it('carries a project root through to the view', async () => {
    const { dir } = await scratchRoot()
    const root: SkillRootInfo = {
      path: dir, source: 'project-dsh', rank: 100, readOnly: false, projectRoot: '/work/app',
    }
    const snapshot = await (await harness([root])).list({})
    expect(snapshot.roots[0]!.projectRoot).toBe('/work/app')
  })

  it('refuses a read of a path that is not a regular file', async () => {
    const { dir, root } = await scratchRoot()
    await mkdir(join(dir, 'adir.md'), { recursive: true })
    await expect((await harness([root])).read({ entryId: join(dir, 'adir.md') as never }))
      .rejects.toMatchObject({ code: 'skill-admin/io-failed' })
  })

  it('reports a write that cannot create its parent', async () => {
    const { dir, root } = await scratchRoot()
    // A plain file where the bundle form needs a directory.
    await writeSkill(join(dir, 'blocked'), 'not a directory\n')
    await expect((await harness([root])).create({
      rootPath: dir, name: 'blocked', description: 'd', content: '', form: 'bundle',
      invocation: { modelInvocable: true, userInvocable: true },
    })).rejects.toMatchObject({ code: 'skill-admin/io-failed' })
  })

  it('updates an entry to an empty body', async () => {
    const { dir, root } = await scratchRoot()
    const path = join(dir, 'demo.md')
    await writeSkill(path, '---\nname: demo\ndescription: d\n---\n\nOld body.\n')
    const manager = await harness([root])
    const entry = (await manager.list({})).roots[0]!.entries[0]!
    await manager.update({
      entryId: entry.entryId,
      description: 'd',
      invocation: { modelInvocable: true, userInvocable: true },
      content: '',
    })
    // The body is gone; the invocation keys were stated explicitly by the
    // write, which is the update path's contract.
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('Old body.')
    expect(text.endsWith('---\n')).toBe(true)
    expect(text).toContain('description: d')
  })
})

describe('entries discovery would drop', () => {
  it('records a file whose YAML is malformed', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'broken.md'), '---\nname: [\n---\n')
    const entries = (await (await harness([root])).list({})).roots[0]!.entries
    expect(entries[0]!.invalid).toMatch(/invalid YAML frontmatter/)
  })

  it('records a file whose frontmatter lacks the required keys', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'thin.md'), '---\nfoo: bar\n---\n')
    const entries = (await (await harness([root])).list({})).roots[0]!.entries
    expect(entries[0]!.invalid).toBe('frontmatter requires name and description')
  })

  it('records a file whose name is not kebab-case', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'Bad_Name.md'), '---\nname: Bad_Name\ndescription: d\n---\n')
    const entries = (await (await harness([root])).list({})).roots[0]!.entries
    expect(entries[0]!.invalid).toMatch(/invalid skill name/)
  })
})

describe('remove failures that are not an absent path', () => {
  it('reports an io failure the filesystem raises for a malformed path', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    // Inside a scanned root (so ownership resolves) but not a path the
    // filesystem accepts, which reaches the non-absent failure arm.
    await expect(manager.delete({ entryId: join(dir, 'bad\0name.md') as never }))
      .rejects.toMatchObject({ code: 'skill-admin/io-failed' })
  })
})

describe('read of an entry with no usage hint', () => {
  it('omits the key rather than carrying undefined', async () => {
    const { dir, root } = await scratchRoot()
    const path = join(dir, 'plain.md')
    await writeSkill(path, '---\nname: plain\ndescription: d\n---\n\nBody.\n')
    const document = await (await harness([root])).read({ entryId: path as never })
    expect(document.whenToUse).toBeUndefined()
  })
})

describe('remove outside every scanned root', () => {
  it('refuses a path no root contains', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    await expect(manager.delete({ entryId: join(dir, '..', 'outside.md') as never }))
      .rejects.toMatchObject({ code: 'skill-admin/entry-not-found' })
  })
})

describe('list with a workspace selection', () => {
  it('echoes the project root the view was resolved for', async () => {
    const { dir, root } = await scratchRoot()
    const snapshot = await (await harness([root])).list({ projectRoot: dir })
    expect(snapshot.projectRoot).toBe(dir)
  })
})

describe('update over a read-only root', () => {
  it('refuses an entry inside a root that ships with the deployment', async () => {
    const { dir } = await scratchRoot()
    const path = join(dir, 'demo.md')
    await writeSkill(path, '---\nname: demo\ndescription: d\n---\n')
    const root: SkillRootInfo = { path: dir, source: 'bundled', rank: 600, readOnly: true }
    const manager = await harness([root])
    await expect(manager.update({
      entryId: path as never,
      description: 'After',
      invocation: { modelInvocable: true, userInvocable: true },
      content: 'New body.',
    })).rejects.toMatchObject({ code: 'skill-admin/root-not-writable' })
    // The file is untouched.
    expect(await readFile(path, 'utf8')).toContain('description: d')
  })

  it('reports an entry whose frontmatter block cannot be edited in place', async () => {
    const { dir, root } = await scratchRoot()
    const path = join(dir, 'broken.md')
    await writeSkill(path, 'no frontmatter\n')
    const manager = await harness([root])
    await expect(manager.update({
      entryId: path as never,
      description: 'After',
      invocation: { modelInvocable: true, userInvocable: true },
      content: '',
    })).rejects.toMatchObject({ code: 'skill-admin/invalid-frontmatter' })
  })

  it('reports an entry that did not rescan after the write', async () => {
    const { dir, root } = await scratchRoot()
    const path = join(dir, 'demo.md')
    await writeSkill(path, '---\nname: demo\ndescription: d\n---\n')
    const manager = await harness([root])
    // The root vanishes between the write and the rescan, which is the one way
    // a write can succeed and the entry still not be discoverable.
    const inner = manager as unknown as {
      scanned: (p: string | undefined) => Promise<unknown[]>
    }
    const original = inner.scanned.bind(manager)
    let calls = 0
    inner.scanned = async (projectRoot: string | undefined) => {
      calls += 1
      return calls === 1 ? await original(projectRoot) : []
    }
    await expect(manager.update({
      entryId: path as never,
      description: 'After',
      invocation: { modelInvocable: true, userInvocable: true },
      content: 'New body.',
    })).rejects.toMatchObject({ code: 'skill-admin/io-failed' })
  })
})

describe('remove', () => {
  it('deletes a flat file', async () => {
    const { dir, root } = await scratchRoot()
    const path = join(dir, 'demo.md')
    await writeSkill(path, '---\nname: demo\ndescription: d\n---\n')
    const manager = await harness([root])
    const entry = (await manager.list({})).roots[0]!.entries[0]!
    await manager.delete({ entryId: entry.entryId })
    expect(await exists(path)).toBe(false)
  })

  it('deletes a bundle directory with everything it holds', async () => {
    const { dir, root } = await scratchRoot()
    const bundle = join(dir, 'demo')
    await writeSkill(join(bundle, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n')
    await writeSkill(join(bundle, 'scripts', 'run.sh'), 'echo hi\n')
    const manager = await harness([root])
    const entry = (await manager.list({})).roots[0]!.entries[0]!
    await manager.delete({ entryId: entry.entryId })
    expect(await exists(bundle)).toBe(false)
  })

  it('refuses an entry no scanned root contains', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    await expect(manager.delete({ entryId: join(dir, 'absent.md') as never }))
      .rejects.toMatchObject({ code: 'skill-admin/entry-not-found' })
  })

  it('refuses an entry inside a read-only root', async () => {
    const { dir } = await scratchRoot()
    const path = join(dir, 'demo.md')
    await writeSkill(path, '---\nname: demo\ndescription: d\n---\n')
    const root: SkillRootInfo = { path: dir, source: 'bundled', rank: 600, readOnly: true }
    const manager = await harness([root])
    await expect(manager.delete({ entryId: path as never }))
      .rejects.toMatchObject({ code: 'skill-admin/root-not-writable' })
    expect(await exists(path)).toBe(true)
  })
})
