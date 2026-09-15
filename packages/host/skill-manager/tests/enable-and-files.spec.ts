import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
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
async function scratchRoot(source = 'user-dsh', rank = 400, readOnly = false): Promise<{ dir: string; root: SkillRootInfo }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-'))
  directories.push(dir)
  return { dir, root: { path: dir, source, rank, readOnly } }
}

/** Mount the gateway over a fixed root list. */
async function harness(roots: readonly SkillRootInfo[]): Promise<SkillManagerGateway> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('skillRoots', { list: async () => roots })
  await ctx.plugin(SkillManagerGateway)
  return ctx.get('skillManager') as SkillManagerGateway
}

/** One skill file's text with usable frontmatter. */
function skillText(name: string, description = `${name} description`): string {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', 'Body.', ''].join('\n')
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

/** Encode one archive as the canonical base64 an upload carries. */
function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

describe('disabled entries', () => {
  it('lists what the parking directory holds as disabled, beside the enabled entries', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'live.md'), skillText('live'))
    await writeSkill(join(dir, '.disabled', 'parked', 'SKILL.md'), skillText('parked'))

    const entries = (await (await harness([root])).list({})).roots[0]!.entries
    expect(entries.map(entry => entry.name)).toEqual(['live', 'parked'])
    expect(entries.find(entry => entry.name === 'live')!.enabled).toBe(true)
    const parked = entries.find(entry => entry.name === 'parked')!
    expect(parked.enabled).toBe(false)
    expect(parked.path).toBe(join(dir, '.disabled', 'parked', 'SKILL.md'))
  })

  it('takes a disabled entry out of shadowing', async () => {
    const { dir, root } = await scratchRoot('user-dsh', 400)
    const { dir: projectDir, root: projectRoot } = await scratchRoot('project-dsh', 100)
    await writeSkill(join(projectDir, 'shared.md'), skillText('shared'))
    await writeSkill(join(dir, '.disabled', 'shared.md'), skillText('shared'))

    const snapshot = await (await harness([projectRoot, root])).list({})
    const parked = snapshot.roots[1]!.entries[0]!
    // A parked entry is outside the scanned set, so it neither wins nor loses a
    // name: it competes again only once it is enabled.
    expect(parked.enabled).toBe(false)
    expect(parked.shadowed).toBe(false)
  })
})

describe('setEnabled', () => {
  it('parks a directory bundle without touching its contents', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    await writeSkill(join(dir, 'demo', 'references', 'notes.md'), 'notes\n')
    const manager = await harness([root])

    const parked = await manager.setEnabled({ entryId: join(dir, 'demo', 'SKILL.md') as never, enabled: false })
    expect(parked.enabled).toBe(false)
    expect(parked.path).toBe(join(dir, '.disabled', 'demo', 'SKILL.md'))
    expect(await exists(join(dir, 'demo'))).toBe(false)
    expect(await readFile(join(dir, '.disabled', 'demo', 'references', 'notes.md'), 'utf8')).toBe('notes\n')
  })

  it('parks a flat file and restores it to its own name', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'flat.md'), skillText('flat'))
    const manager = await harness([root])

    const parked = await manager.setEnabled({ entryId: join(dir, 'flat.md') as never, enabled: false })
    expect(parked.path).toBe(join(dir, '.disabled', 'flat.md'))

    const restored = await manager.setEnabled({ entryId: parked.entryId, enabled: true })
    expect(restored.enabled).toBe(true)
    expect(restored.path).toBe(join(dir, 'flat.md'))
    expect(await exists(join(dir, '.disabled', 'flat.md'))).toBe(false)
  })

  it('treats a request naming the current state as a no-op', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'flat.md'), skillText('flat'))
    const manager = await harness([root])

    const same = await manager.setEnabled({ entryId: join(dir, 'flat.md') as never, enabled: true })
    expect(same.enabled).toBe(true)
    expect(await exists(join(dir, 'flat.md'))).toBe(true)
  })

  it('refuses to overwrite whatever already holds the destination', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, '.disabled', 'taken.md'), skillText('taken'))
    await writeSkill(join(dir, 'taken.md'), skillText('taken'))
    const manager = await harness([root])

    const parked = (await manager.list({})).roots[0]!.entries.find(entry => !entry.enabled)!
    await expect(manager.setEnabled({ entryId: parked.entryId, enabled: true }))
      .rejects.toMatchObject({ code: 'skill-admin/entry-exists' })
  })

  it('refuses a root this deployment does not write', async () => {
    const { dir, root } = await scratchRoot('bundled', 600, true)
    await writeSkill(join(dir, 'packaged.md'), skillText('packaged'))
    const manager = await harness([root])

    await expect(manager.setEnabled({ entryId: join(dir, 'packaged.md') as never, enabled: false }))
      .rejects.toMatchObject({ code: 'skill-admin/root-not-writable' })
  })

  it('refuses an entry no scanned root holds', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    await expect(manager.setEnabled({ entryId: join(dir, 'absent.md') as never, enabled: false }))
      .rejects.toMatchObject({ code: 'skill-admin/entry-not-found' })
  })
})

describe('listFiles and readFile', () => {
  it('lists every file a bundle holds, in path order', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    await writeSkill(join(dir, 'demo', 'references', 'notes.md'), 'notes\n')
    await writeSkill(join(dir, 'demo', 'scripts', 'run.sh'), 'echo hi\n')
    const manager = await harness([root])

    const tree = await manager.listFiles({ entryId: join(dir, 'demo', 'SKILL.md') as never })
    expect(tree.directory).toBe(join(dir, 'demo'))
    expect(tree.files.map(file => file.path)).toEqual(['SKILL.md', 'references/notes.md', 'scripts/run.sh'])
    expect(tree.truncated).toBe(false)
  })

  it('lists only the file a flat skill owns', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'flat.md'), skillText('flat'))
    await writeSkill(join(dir, 'sibling.md'), skillText('sibling'))
    const manager = await harness([root])

    const tree = await manager.listFiles({ entryId: join(dir, 'flat.md') as never })
    expect(tree.files.map(file => file.path)).toEqual(['flat.md'])
  })

  it('reads one file of a bundle', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    await writeSkill(join(dir, 'demo', 'scripts', 'run.sh'), 'echo hi\n')
    const manager = await harness([root])

    const document = await manager.readFile({
      entryId: join(dir, 'demo', 'SKILL.md') as never,
      path: 'scripts/run.sh',
    })
    expect(document.text).toBe('echo hi\n')
    expect(document.editable).toBe(true)
  })

  it('withholds a binary file and a file past the size bound', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    await writeFile(join(dir, 'demo', 'logo.png'), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))
    await writeFile(join(dir, 'demo', 'huge.txt'), 'x'.repeat(512 * 1024 + 1))
    const manager = await harness([root])
    const entryId = join(dir, 'demo', 'SKILL.md') as never

    const binary = await manager.readFile({ entryId, path: 'logo.png' })
    expect(binary).toMatchObject({ editable: false, readOnlyReason: 'binary', text: '' })

    const huge = await manager.readFile({ entryId, path: 'huge.txt' })
    expect(huge).toMatchObject({ editable: false, readOnlyReason: 'too-large', text: '' })
  })

  it('refuses a path that leaves the entry', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    await writeSkill(join(dir, 'outside.md'), skillText('outside'))
    const manager = await harness([root])
    const entryId = join(dir, 'demo', 'SKILL.md') as never

    for (const path of ['../outside.md', '/etc/passwd', '']) {
      await expect(manager.readFile({ entryId, path }))
        .rejects.toMatchObject({ code: 'skill-admin/file-escapes-entry' })
    }
  })

  it('refuses a sibling file addressed through a flat skill', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'flat.md'), skillText('flat'))
    await writeSkill(join(dir, 'sibling.md'), skillText('sibling'))
    const manager = await harness([root])

    await expect(manager.readFile({ entryId: join(dir, 'flat.md') as never, path: 'sibling.md' }))
      .rejects.toMatchObject({ code: 'skill-admin/file-escapes-entry' })
  })

  it('reports a file that is not there', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    const manager = await harness([root])

    await expect(manager.readFile({ entryId: join(dir, 'demo', 'SKILL.md') as never, path: 'absent.md' }))
      .rejects.toMatchObject({ code: 'skill-admin/file-not-found' })
  })
})

describe('writeFile', () => {
  it('replaces one file and leaves its siblings alone', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    await writeSkill(join(dir, 'demo', 'scripts', 'run.sh'), 'echo hi\n')
    const manager = await harness([root])

    await manager.writeFile({
      entryId: join(dir, 'demo', 'SKILL.md') as never,
      path: 'scripts/run.sh',
      text: 'echo changed\n',
    })

    expect(await readFile(join(dir, 'demo', 'scripts', 'run.sh'), 'utf8')).toBe('echo changed\n')
    expect(await readFile(join(dir, 'demo', 'SKILL.md'), 'utf8')).toBe(skillText('demo'))
  })

  it('refuses an entry point that would no longer be discoverable', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    const manager = await harness([root])
    const entryId = join(dir, 'demo', 'SKILL.md') as never

    const withoutDescription = ['---', 'name: demo', '---', '', 'Body.', ''].join('\n')
    await expect(manager.writeFile({ entryId, path: 'SKILL.md', text: withoutDescription }))
      .rejects.toMatchObject({ code: 'skill-admin/invalid-frontmatter' })

    await expect(manager.writeFile({ entryId, path: 'SKILL.md', text: 'no frontmatter\n' }))
      .rejects.toMatchObject({ code: 'skill-admin/invalid-frontmatter' })

    await expect(manager.writeFile({ entryId, path: 'SKILL.md', text: ['---', 'name: Not Kebab', 'description: d', '---', ''].join('\n') }))
      .rejects.toMatchObject({ code: 'skill-admin/invalid-frontmatter' })

    expect(await readFile(join(dir, 'demo', 'SKILL.md'), 'utf8')).toBe(skillText('demo'))
  })

  it('accepts an entry point that stays discoverable', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    const manager = await harness([root])

    const rewritten = ['---', 'name: demo', 'description: Rewritten', '---', '', 'New body.', ''].join('\n')
    await manager.writeFile({ entryId: join(dir, 'demo', 'SKILL.md') as never, path: 'SKILL.md', text: rewritten })
    expect(await readFile(join(dir, 'demo', 'SKILL.md'), 'utf8')).toBe(rewritten)
  })

  it('guards a flat skill\'s own file, not only one named SKILL.md', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'flat.md'), skillText('flat'))
    const manager = await harness([root])

    const withoutDescription = ['---', 'name: flat', '---', '', 'Body.', ''].join('\n')
    await expect(manager.writeFile({ entryId: join(dir, 'flat.md') as never, path: 'flat.md', text: withoutDescription }))
      .rejects.toMatchObject({ code: 'skill-admin/invalid-frontmatter' })

    expect(await readFile(join(dir, 'flat.md'), 'utf8')).toBe(skillText('flat'))
  })

  it('refuses a root this deployment does not write', async () => {
    const { dir, root } = await scratchRoot('bundled', 600, true)
    await writeSkill(join(dir, 'packaged', 'SKILL.md'), skillText('packaged'))
    const manager = await harness([root])

    await expect(manager.writeFile({
      entryId: join(dir, 'packaged', 'SKILL.md') as never,
      path: 'SKILL.md',
      text: skillText('packaged', 'Other'),
    })).rejects.toMatchObject({ code: 'skill-admin/root-not-writable' })
  })

  it('refuses to replace a file the editor cannot read', async () => {
    const { dir, root } = await scratchRoot()
    await writeSkill(join(dir, 'demo', 'SKILL.md'), skillText('demo'))
    await writeFile(join(dir, 'demo', 'logo.png'), Uint8Array.from([0x89, 0x00, 0x1a]))
    const manager = await harness([root])

    await expect(manager.writeFile({
      entryId: join(dir, 'demo', 'SKILL.md') as never,
      path: 'logo.png',
      text: 'not an image',
    })).rejects.toMatchObject({ code: 'skill-admin/file-not-writable' })
  })
})

describe('previewUpload', () => {
  it('unpacks an uploaded archive into the same preview a URL import produces', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    const archive = zipSync({
      'SKILL.md': new TextEncoder().encode(skillText('imported', 'From a zip')),
      'scripts/run.sh': new TextEncoder().encode('echo hi\n'),
    })

    const preview = await manager.previewUpload({
      fileName: 'skill.zip',
      data: encode(archive),
      rootPath: dir,
    })

    expect(preview.name).toBe('imported')
    expect(preview.description).toBe('From a zip')
    expect(preview.origin).toBe('upload:skill.zip')
    expect(preview.targetPath).toBe(join(dir, 'imported'))
    expect(preview.files.map(file => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(preview.replaces).toBe(false)
    expect(await exists(join(dir, 'imported'))).toBe(false)

    await manager.commitImport({ previewId: preview.previewId })
    expect(await readFile(join(dir, 'imported', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n')
  })

  it('reads one staged member for inspection without consuming the preview', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    const archive = zipSync({
      'SKILL.md': new TextEncoder().encode(skillText('imported', 'From a zip')),
      'scripts/run.sh': new TextEncoder().encode('echo hi\n'),
      'logo.png': Uint8Array.from([0x89, 0x50, 0x00, 0x1a]),
    })
    const preview = await manager.previewUpload({ fileName: 'skill.zip', data: encode(archive), rootPath: dir })

    const entryPoint = await manager.readPreviewFile({ previewId: preview.previewId, path: 'SKILL.md' })
    expect(entryPoint.text).toContain('name: imported')

    const member = await manager.readPreviewFile({ previewId: preview.previewId, path: 'scripts/run.sh' })
    expect(member.text).toBe('echo hi\n')

    const binary = await manager.readPreviewFile({ previewId: preview.previewId, path: 'logo.png' })
    expect(binary).toMatchObject({ text: '', unreadableReason: 'binary' })

    // Inspection is not approval: the commit that follows still finds the whole
    // staged set, so reading a preview can never write it by accident.
    await manager.commitImport({ previewId: preview.previewId })
    expect(await readFile(join(dir, 'imported', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n')
  })

  it('refuses a member the preview does not hold', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    const archive = zipSync({ 'SKILL.md': new TextEncoder().encode(skillText('imported')) })
    const preview = await manager.previewUpload({ fileName: 'a.zip', data: encode(archive), rootPath: dir })

    await expect(manager.readPreviewFile({ previewId: preview.previewId, path: '../outside.md' }))
      .rejects.toMatchObject({ code: 'skill-admin/file-not-found' })
  })

  it('refuses to inspect a preview that is gone', async () => {
    const { root } = await scratchRoot()
    const manager = await harness([root])

    await expect(manager.readPreviewFile({ previewId: 'gone' as never, path: 'SKILL.md' }))
      .rejects.toMatchObject({ code: 'skill-admin/import-expired' })
  })

  it('refuses a payload that is not canonical base64', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])

    await expect(manager.previewUpload({ fileName: 'a.zip', data: 'not base64!!', rootPath: dir }))
      .rejects.toMatchObject({ code: 'skill-admin/upload-invalid' })
  })

  it('refuses a payload past the upload bound before unpacking it', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    const oversized = encode(Buffer.alloc(16 * 1024 * 1024 + 1))

    await expect(manager.previewUpload({ fileName: 'a.zip', data: oversized, rootPath: dir }))
      .rejects.toMatchObject({ code: 'skill-admin/upload-invalid' })
  })

  it('refuses an archive whose members leave the skill directory', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    const archive = zipSync({
      'SKILL.md': new TextEncoder().encode(skillText('escaped')),
      '../outside.md': new TextEncoder().encode('escaped\n'),
    })

    await expect(manager.previewUpload({ fileName: 'evil.zip', data: encode(archive), rootPath: dir }))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('refuses an upload that carries no usable entry point', async () => {
    const { dir, root } = await scratchRoot()
    const manager = await harness([root])
    const archive = zipSync({ 'readme.md': new TextEncoder().encode('nothing here\n') })

    await expect(manager.previewUpload({ fileName: 'a.zip', data: encode(archive), rootPath: dir }))
      .rejects.toMatchObject({ code: 'skill-admin/import-no-skill' })
  })

  it('refuses a root this deployment does not write', async () => {
    const { dir, root } = await scratchRoot('bundled', 600, true)
    const manager = await harness([root])
    const archive = zipSync({ 'SKILL.md': new TextEncoder().encode(skillText('imported')) })

    await expect(manager.previewUpload({ fileName: 'a.zip', data: encode(archive), rootPath: dir }))
      .rejects.toMatchObject({ code: 'skill-admin/root-not-writable' })
  })
})
