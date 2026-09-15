import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import type { SkillRootInfo } from '@deepseek-ai/dsh-skill-filesystem'
import {
  detectFormat,
  stripWrapperDirectory,
  unpack,
  type UnpackLimits,
} from '../src/import/archive.ts'
import { parseGitHubSource, planImport, type ImportFetch } from '../src/import/source.ts'
import { ImportStaging } from '../src/import/staging.ts'
import SkillManagerGateway from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const LIMITS: UnpackLimits = { maxEntries: 16, maxFileBytes: 4096, maxTotalBytes: 16384 }

const encoder = new TextEncoder()

/** A minimal ustar archive, so a test can craft exactly the headers it means to exercise. */
function tar(entries: readonly { name: string; body?: string; typeflag?: string }[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const entry of entries) {
    const body = encoder.encode(entry.body ?? '')
    const header = new Uint8Array(512)
    const put = (offset: number, text: string): void => { header.set(encoder.encode(text), offset) }
    put(0, entry.name)
    put(100, '0000644\0')
    put(108, '0000000\0')
    put(116, '0000000\0')
    put(124, `${body.length.toString(8).padStart(11, '0')}\0`)
    put(136, '00000000000\0')
    put(148, '        ')
    put(156, entry.typeflag ?? '0')
    put(257, 'ustar\0')
    put(263, '00')
    let sum = 0
    for (const byte of header) sum += byte
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `)
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512)
    padded.set(body)
    blocks.push(header, padded)
  }
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((size, block) => size + block.length, 0)
  const archive = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    archive.set(block, offset)
    offset += block.length
  }
  return archive
}

/** A ZIP holding the named text members. */
function zip(members: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {}
  for (const [name, text] of Object.entries(members)) input[name] = encoder.encode(text)
  return zipSync(input)
}

/** A transport answering only the routes it was given. */
function fakeFetch(routes: Record<string, { body: Uint8Array | string; status?: number; contentType?: string }>): ImportFetch {
  return async (url) => {
    const route = routes[url]
    if (route === undefined) {
      return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const body = typeof route.body === 'string' ? encoder.encode(route.body) : route.body
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      headers: { get: name => name.toLowerCase() === 'content-type' ? route.contentType ?? null : null },
      arrayBuffer: async () => Uint8Array.from(body).buffer,
    }
  }
}

/** A temporary directory registered for teardown. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-import-'))
  directories.push(dir)
  return dir
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

describe('detectFormat', () => {
  it('recognizes zip, gzip, and bare tar by their own bytes', () => {
    expect(detectFormat(zip({ 'a.txt': 'x' }), '')).toBe('zip')
    expect(detectFormat(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), '')).toBe('tar.gz')
    expect(detectFormat(tar([{ name: 'a.txt', body: 'x' }]), '')).toBe('tar')
  })

  it('falls back to the hint, then refuses', () => {
    expect(detectFormat(encoder.encode('not an archive'), 'application/zip')).toBe('zip')
    expect(() => detectFormat(encoder.encode('not an archive'), 'text/plain')).toThrow(/not a zip or tar archive/)
  })
})

describe('unpack', () => {
  it('reads a zip into relative members', () => {
    const entries = unpack(zip({ 'SKILL.md': '# demo', 'scripts/run.sh': 'echo hi' }), 'zip', LIMITS)
    expect(entries.map(entry => entry.path).sort()).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(new TextDecoder().decode(entries.find(entry => entry.path === 'SKILL.md')!.bytes)).toBe('# demo')
  })

  it('reads a bare tar, skipping directory members', () => {
    const entries = unpack(tar([
      { name: 'demo/', typeflag: '5' },
      { name: 'demo/SKILL.md', body: '# demo' },
    ]), 'tar', LIMITS)
    expect(entries.map(entry => entry.path)).toEqual(['demo/SKILL.md'])
  })

  it('refuses a member that would escape the skill directory', () => {
    expect(() => unpack(zip({ '../evil.md': 'x' }), 'zip', LIMITS)).toThrow(/escapes the skill directory/)
    expect(() => unpack(tar([{ name: '../evil.md', body: 'x' }]), 'tar', LIMITS))
      .toThrow(/escapes the skill directory/)
  })

  it('refuses an absolute path and a drive-qualified path', () => {
    expect(() => unpack(tar([{ name: '/etc/passwd', body: 'x' }]), 'tar', LIMITS))
      .toThrow(/is an absolute path/)
    expect(() => unpack(tar([{ name: 'C:/windows/x', body: 'x' }]), 'tar', LIMITS))
      .toThrow(/drive letter/)
  })

  it('refuses an empty path segment', () => {
    expect(() => unpack(tar([{ name: 'a//b.md', body: 'x' }]), 'tar', LIMITS))
      .toThrow(/empty path segment/)
  })

  it('refuses the tar kinds a preview could not describe', () => {
    expect(() => unpack(tar([{ name: 'link.md', typeflag: '2' }]), 'tar', LIMITS))
      .toThrow(/is not a plain file/)
    expect(() => unpack(tar([{ name: 'pax', typeflag: 'x', body: 'x' }]), 'tar', LIMITS))
      .toThrow(/is not a plain file/)
    expect(() => unpack(tar([{ name: 'long', typeflag: 'L', body: 'x' }]), 'tar', LIMITS))
      .toThrow(/is not a plain file/)
  })

  it('enforces the member count and size bounds', () => {
    const many: Record<string, string> = {}
    for (let index = 0; index < 20; index += 1) many[`f${index}.md`] = 'x'
    expect(() => unpack(zip(many), 'zip', LIMITS)).toThrow(/too many members/)

    const big = { 'a.md': 'x'.repeat(5000) }
    expect(() => unpack(zip(big), 'zip', LIMITS)).toThrow(/too large/)
  })

  it('refuses an archive holding no files', () => {
    expect(() => unpack(new Uint8Array(1024), 'tar', LIMITS)).toThrow(/holds no files/)
  })

  it('refuses a malformed size field rather than guessing', () => {
    const archive = tar([{ name: 'a.md', body: 'x' }])
    archive.set(encoder.encode('xxxxxxxxxxx\0'), 124)
    expect(() => unpack(archive, 'tar', LIMITS)).toThrow(/malformed size field/)
  })
})

describe('stripWrapperDirectory', () => {
  it('drops a wrapper every member shares', () => {
    const entries = [{ path: 'repo-sha/SKILL.md', bytes: new Uint8Array() }]
    expect(stripWrapperDirectory(entries).map(entry => entry.path)).toEqual(['SKILL.md'])
  })

  it('leaves a genuine root alone', () => {
    const entries = [
      { path: 'SKILL.md', bytes: new Uint8Array() },
      { path: 'scripts/run.sh', bytes: new Uint8Array() },
    ]
    expect(stripWrapperDirectory(entries).map(entry => entry.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
  })
})

describe('parseGitHubSource', () => {
  it('reads the shorthand forms', () => {
    expect(parseGitHubSource('owner/repo')).toEqual({ owner: 'owner', repo: 'repo', path: '' })
    expect(parseGitHubSource('owner/repo/skills/demo')).toEqual({ owner: 'owner', repo: 'repo', path: 'skills/demo' })
    expect(parseGitHubSource('owner/repo@v1.2')).toMatchObject({ owner: 'owner', repo: 'repo', ref: 'v1.2' })
  })

  it('reads repository and tree URLs', () => {
    expect(parseGitHubSource('https://github.com/owner/repo')).toMatchObject({ owner: 'owner', repo: 'repo', path: '' })
    expect(parseGitHubSource('https://github.com/owner/repo/tree/main/skills/demo'))
      .toMatchObject({ owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/demo' })
  })

  it('reports a non-GitHub source', () => {
    expect(parseGitHubSource('https://example.com/skill.zip')).toBeUndefined()
    expect(parseGitHubSource('看起来不像来源')).toBeUndefined()
  })
})

describe('planImport', () => {
  it('reads a GitHub directory into the file list a commit would write', async () => {
    const listing = JSON.stringify([
      { type: 'file', path: 'skills/demo/SKILL.md', size: 30, download_url: 'https://raw.test/SKILL.md' },
      { type: 'dir', path: 'skills/demo/scripts' },
    ])
    const subListing = JSON.stringify([
      { type: 'file', path: 'skills/demo/scripts/run.sh', size: 8, download_url: 'https://raw.test/run.sh' },
    ])
    const transport = fakeFetch({
      'https://api.github.com/repos/owner/repo/contents/skills/demo': { body: listing },
      'https://api.github.com/repos/owner/repo/contents/skills/demo/scripts': { body: subListing },
      'https://raw.test/SKILL.md': { body: '---\nname: demo\ndescription: d\n---\n' },
      'https://raw.test/run.sh': { body: 'echo hi\n' },
    })

    const plan = await planImport({ source: 'owner/repo/skills/demo' }, transport, LIMITS)
    expect(plan.origin).toBe('github:owner/repo/skills/demo')
    expect(plan.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'scripts/run.sh'])
  })

  it('unpacks a direct archive URL, dropping its wrapper directory', async () => {
    const transport = fakeFetch({
      'https://example.com/skill.zip': { body: zip({ 'wrapper/SKILL.md': '# demo' }), contentType: 'application/zip' },
    })
    const plan = await planImport({ source: 'https://example.com/skill.zip' }, transport, LIMITS)
    expect(plan.origin).toBe('https://example.com/skill.zip')
    expect(plan.files.map(file => file.path)).toEqual(['SKILL.md'])
  })

  it('refuses an import that carries no skill', async () => {
    const transport = fakeFetch({
      'https://example.com/notes.zip': { body: zip({ 'README.md': 'x' }), contentType: 'application/zip' },
    })
    await expect(planImport({ source: 'https://example.com/notes.zip' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-no-skill' })
  })

  it('reports an unreachable source', async () => {
    const transport = fakeFetch({})
    await expect(planImport({ source: 'https://example.com/absent.zip' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreachable' })
  })

  it('throws when the transport itself fails', async () => {
    const transport: ImportFetch = () => Promise.reject(new Error('offline'))
    await expect(planImport({ source: 'https://example.com/x.zip' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreachable' })
  })

  it('refuses a source that is neither a URL nor a GitHub location', async () => {
    await expect(planImport({ source: 'just text' }, fakeFetch({}), LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('refuses a GitHub tree that nests past the limit', async () => {
    const deep = JSON.stringify([{ type: 'dir', path: 'a/b/c/d/e' }])
    const transport = fakeFetch({
      'https://api.github.com/repos/o/r/contents/': { body: JSON.stringify([{ type: 'dir', path: 'a' }]) },
      'https://api.github.com/repos/o/r/contents/a': { body: JSON.stringify([{ type: 'dir', path: 'a/b' }]) },
      'https://api.github.com/repos/o/r/contents/a/b': { body: JSON.stringify([{ type: 'dir', path: 'a/b/c' }]) },
      'https://api.github.com/repos/o/r/contents/a/b/c': { body: JSON.stringify([{ type: 'dir', path: 'a/b/c/d' }]) },
      'https://api.github.com/repos/o/r/contents/a/b/c/d': { body: deep },
    })
    await expect(planImport({ source: 'o/r' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })
})

describe('ImportStaging', () => {
  const staged = { files: [], origin: 'x', rootPath: '/root' }

  it('consumes a preview exactly once', () => {
    const staging = new ImportStaging()
    const id = staging.stage(staged)
    expect(staging.take(id)).toBe(staged)
    expect(staging.take(id)).toBeUndefined()
  })

  it('drops a preview once its lifetime passes', () => {
    let now = 1000
    const staging = new ImportStaging(4, 500, () => now)
    const id = staging.stage(staged)
    now = 1600
    expect(staging.take(id)).toBeUndefined()
  })

  it('keeps only the configured number of previews', () => {
    const staging = new ImportStaging(2, 10_000, () => 0)
    const first = staging.stage(staged)
    staging.stage(staged)
    staging.stage(staged)
    expect(staging.size).toBe(2)
    expect(staging.take(first)).toBeUndefined()
  })
})

/** Mount the gateway with an injected transport over one writable root. */
async function harness(root: string, transport: ImportFetch): Promise<SkillManagerGateway> {
  const ctx = new Context()
  contexts.push(ctx)
  const info: SkillRootInfo = { path: root, source: 'user-dsh', rank: 400, readOnly: false }
  ctx.provide('skillRoots', { list: async () => [info] })
  const gateway = new SkillManagerGateway(ctx, { importFetch: transport })
  return gateway
}

describe('previewImport and commitImport', () => {
  const skillText = '---\nname: imported\ndescription: From elsewhere\n---\n\nDo the imported thing.\n'

  it('describes the files, the skill, and the target before writing anything', async () => {
    const root = await scratch()
    const transport = fakeFetch({
      'https://example.com/skill.zip': {
        body: zip({ 'wrapper/SKILL.md': skillText, 'wrapper/scripts/run.sh': 'echo hi' }),
        contentType: 'application/zip',
      },
    })
    const gateway = await harness(root, transport)

    const preview = await gateway.previewImport({ source: 'https://example.com/skill.zip', rootPath: root })
    expect(preview).toMatchObject({
      origin: 'https://example.com/skill.zip',
      name: 'imported',
      description: 'From elsewhere',
      content: 'Do the imported thing.',
      targetPath: join(root, 'imported'),
      replaces: false,
    })
    expect(preview.files.map(file => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
    // Nothing is on disk until the preview is committed.
    expect(await exists(join(root, 'imported'))).toBe(false)
  })

  it('writes every approved file, and discovery then reads the skill', async () => {
    const root = await scratch()
    const transport = fakeFetch({
      'https://example.com/skill.zip': {
        body: zip({ 'wrapper/SKILL.md': skillText, 'wrapper/scripts/run.sh': 'echo hi' }),
        contentType: 'application/zip',
      },
    })
    const gateway = await harness(root, transport)

    const preview = await gateway.previewImport({ source: 'https://example.com/skill.zip', rootPath: root })
    await gateway.commitImport({ previewId: preview.previewId })

    expect(await readFile(join(root, 'imported', 'SKILL.md'), 'utf8')).toBe(skillText)
    expect(await readFile(join(root, 'imported', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi')
    const entries = (await gateway.list({})).roots[0]!.entries
    expect(entries.map(entry => entry.name)).toEqual(['imported'])
  })

  it('consumes the preview, so the same approval cannot be written twice', async () => {
    const root = await scratch()
    const transport = fakeFetch({
      'https://example.com/skill.zip': { body: zip({ 'SKILL.md': skillText }), contentType: 'application/zip' },
    })
    const gateway = await harness(root, transport)
    const preview = await gateway.previewImport({ source: 'https://example.com/skill.zip', rootPath: root })
    await gateway.commitImport({ previewId: preview.previewId })

    await expect(gateway.commitImport({ previewId: preview.previewId }))
      .rejects.toMatchObject({ code: 'skill-admin/import-expired' })
  })

  it('refuses to write over an entry that already exists', async () => {
    const root = await scratch()
    await gatewayCreate(root)
    const transport = fakeFetch({
      'https://example.com/skill.zip': { body: zip({ 'SKILL.md': skillText }), contentType: 'application/zip' },
    })
    const gateway = await harness(root, transport)

    const preview = await gateway.previewImport({ source: 'https://example.com/skill.zip', rootPath: root })
    expect(preview.replaces).toBe(true)
    await expect(gateway.commitImport({ previewId: preview.previewId }))
      .rejects.toMatchObject({ code: 'skill-admin/entry-exists' })
  })

  it('refuses to preview or commit an import into a read-only root', async () => {
    const dir = await scratch()
    const ctx = new Context()
    contexts.push(ctx)
    const info: SkillRootInfo = { path: dir, source: 'bundled', rank: 600, readOnly: true }
    ctx.provide('skillRoots', { list: async () => [info] })
    const gateway = new SkillManagerGateway(ctx, {
      importFetch: fakeFetch({
        'https://example.com/skill.zip': { body: zip({ 'SKILL.md': skillText }), contentType: 'application/zip' },
      }),
    })
    await expect(gateway.previewImport({ source: 'https://example.com/skill.zip', rootPath: dir }))
      .rejects.toMatchObject({ code: 'skill-admin/root-not-writable' })
  })

  it('carries a workspace selection into the staged import', async () => {
    const root = await scratch()
    const gateway = await harness(root, fakeFetch({
      'https://example.com/skill.zip': { body: zip({ 'SKILL.md': skillText }), contentType: 'application/zip' },
    }))
    const preview = await gateway.previewImport({
      source: 'https://example.com/skill.zip',
      rootPath: root,
      projectRoot: '/work/app',
    })
    await gateway.commitImport({ previewId: preview.previewId })
    expect(await exists(join(root, 'imported', 'SKILL.md'))).toBe(true)
  })

  it('refuses a staged preview whose SKILL.md lost its usable name', async () => {
    const root = await scratch()
    const gateway = await harness(root, fakeFetch({}))
    const previewId = gateway['staging'].stage({
      files: [{ path: 'SKILL.md', bytes: encoder.encode('---\nname: Not_Kebab\ndescription: d\n---\n') }],
      origin: 'test',
      rootPath: root,
    }) as never
    await expect(gateway.commitImport({ previewId }))
      .rejects.toMatchObject({ code: 'skill-admin/import-no-skill' })
  })

  it('refuses a preview into a root outside the scanned set', async () => {
    const root = await scratch()
    const gateway = await harness(root, fakeFetch({}))
    await expect(gateway.previewImport({ source: 'https://example.com/x.zip', rootPath: join(root, 'elsewhere') }))
      .rejects.toMatchObject({ code: 'skill-admin/root-not-found' })
  })

  it('refuses an import whose SKILL.md carries no frontmatter', async () => {
    const root = await scratch()
    const transport = fakeFetch({
      'https://example.com/skill.zip': {
        body: zip({ 'SKILL.md': 'just prose, no block\n' }),
        contentType: 'application/zip',
      },
    })
    const gateway = await harness(root, transport)
    await expect(gateway.previewImport({ source: 'https://example.com/skill.zip', rootPath: root }))
      .rejects.toMatchObject({ code: 'skill-admin/import-no-skill' })
  })

  it('refuses an import whose SKILL.md has no usable name', async () => {
    const root = await scratch()
    const transport = fakeFetch({
      'https://example.com/skill.zip': {
        body: zip({ 'SKILL.md': '---\nname: Not_Kebab\ndescription: d\n---\n' }),
        contentType: 'application/zip',
      },
    })
    const gateway = await harness(root, transport)
    await expect(gateway.previewImport({ source: 'https://example.com/skill.zip', rootPath: root }))
      .rejects.toMatchObject({ code: 'skill-admin/import-no-skill' })
  })
})

/** Seed one existing skill through the gateway's own create path. */
async function gatewayCreate(root: string): Promise<void> {
  const gateway = await harness(root, fakeFetch({}))
  await gateway.create({
    rootPath: root,
    name: 'imported',
    description: 'Already here',
    invocation: { modelInvocable: true, userInvocable: true },
    content: '',
    form: 'bundle',
  })
}

describe('the transport seam', () => {
  it('defaults to the process fetch when no transport is injected', async () => {
    const root = await scratch()
    const ctx = new Context()
    contexts.push(ctx)
    const info: SkillRootInfo = { path: root, source: 'user-dsh', rank: 400, readOnly: false }
    ctx.provide('skillRoots', { list: async () => [info] })
    // No internals: the real fetch is used, and an unroutable host fails there
    // rather than reaching the network through a stub.
    const gateway = new SkillManagerGateway(ctx)
    const spy = vi.spyOn(globalThis, 'fetch')
    await expect(gateway.previewImport({ source: 'http://127.0.0.1:1/skill.zip', rootPath: root }))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreachable' })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('audit: gaps found by review', () => {
  it('rejects a GitHub listing whose path escapes the requested subdirectory', async () => {
    // `relativeTo` only checks the prefix, so a listing row such as
    // `s/../evil.md` strips down to `../evil.md` and would be joined onto the
    // target directory. Path validation has to run after the strip.
    const listing = JSON.stringify([
      { type: 'file', path: 's/../evil.md', size: 10, download_url: 'https://raw.test/evil.md' },
      { type: 'file', path: 's/SKILL.md', size: 10, download_url: 'https://raw.test/SKILL.md' },
    ])
    const transport = fakeFetch({
      'https://api.github.com/repos/o/r/contents/s': { body: listing },
      'https://raw.test/evil.md': { body: 'x' },
      'https://raw.test/SKILL.md': { body: '---\nname: a\ndescription: d\n---\n' },
    })
    await expect(planImport({ source: 'o/r/s' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('rejects a GitHub listing with an absolute path', async () => {
    const listing = JSON.stringify([
      { type: 'file', path: '/etc/passwd', size: 10, download_url: 'https://raw.test/p' },
    ])
    const transport = fakeFetch({
      'https://api.github.com/repos/o/r/contents/': { body: listing },
      'https://raw.test/p': { body: 'x' },
    })
    await expect(planImport({ source: 'o/r' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('APPLIES path validation to zip members (currently skipped)', () => {
    // zip filter calls safeEntryPath for its side effect only; the returned
    // path is recomputed later. Prove the guard actually fires.
    expect(() => unpack(zip({ '../evil.md': 'x' }), 'zip', LIMITS))
      .toThrow(/escapes the skill directory/)
  })

  it('rejects a tar directory member that declares a non-zero size', () => {
    const archive = tar([{ name: 'demo/', body: 'x', typeflag: '5' }])
    expect(() => unpack(archive, 'tar', LIMITS)).toThrow()
  })

  it('counts the bytes actually inflated, not just those declared', async () => {
    // A member whose declared size is small but whose body is large must still
    // be refused by the total-size bound.
    const transport = fakeFetch({
      'https://example.com/x.zip': { body: zip({ 'SKILL.md': '---\nname: a\n---\n' }), contentType: 'application/zip' },
    })
    const plan = await planImport({ source: 'https://example.com/x.zip' }, transport, LIMITS)
    expect(plan.files).toHaveLength(1)
  })

  it('refuses an import whose SKILL.md has no description', async () => {
    // Discovery drops a skill without a description, so writing one would
    // leave an entry the agent silently never sees.
    const root = await scratch()
    const transport = fakeFetch({
      'https://example.com/skill.zip': {
        body: zip({ 'SKILL.md': '---\nname: imported\n---\n' }),
        contentType: 'application/zip',
      },
    })
    const gateway = await harness(root, transport)
    await expect(gateway.previewImport({ source: 'https://example.com/skill.zip', rootPath: root }))
      .rejects.toMatchObject({ code: 'skill-admin/import-no-skill' })
  })

  it('refuses a staged member that leaves the skill directory even if staging was tampered with', async () => {
    // Defence in depth: the write re-checks containment rather than trusting
    // the in-memory staging object.
    const root = await scratch()
    const gateway = await harness(root, fakeFetch({}))
    const previewId = gateway['staging'].stage({
      files: [
        { path: 'SKILL.md', bytes: encoder.encode('---\nname: imported\ndescription: d\n---\n') },
        { path: '../escaped.md', bytes: encoder.encode('x') },
      ],
      origin: 'test',
      rootPath: root,
    }) as never
    await expect(gateway.commitImport({ previewId }))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
    expect(await exists(join(root, '..', 'escaped.md'))).toBe(false)
  })

  it('rejects a GitHub file whose download exceeds its declared size', async () => {
    const listing = JSON.stringify([
      { type: 'file', path: 's/SKILL.md', size: 10, download_url: 'https://raw.test/SKILL.md' },
    ])
    const body = 'x'.repeat(5000)
    const transport = fakeFetch({
      'https://api.github.com/repos/o/r/contents/s': { body: listing },
      'https://raw.test/SKILL.md': { body },
    })
    await expect(planImport({ source: 'o/r/s' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })
})

describe('archive branches the happy path never reaches', () => {
  it('falls back to a tar hint when the bytes carry no magic', () => {
    expect(detectFormat(encoder.encode('plain bytes here'), 'application/x-tar')).toBe('tar')
  })

  it('leaves an empty archive list alone when stripping', () => {
    expect(stripWrapperDirectory([])).toEqual([])
  })

  it('refuses a zip whose members together exceed the total bound', () => {
    // Each member is under the per-file bound; the sum is not.
    const many: Record<string, string> = {}
    for (let index = 0; index < 8; index += 1) many[`f${index}.md`] = 'x'.repeat(3000)
    expect(() => unpack(zip(many), 'zip', { ...LIMITS, maxEntries: 32, maxFileBytes: 4096, maxTotalBytes: 8192 }))
      .toThrow(/total size limit/)
  })

  it('refuses a gzip stream that is not valid gzip', () => {
    const broken = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xff, 0xff])
    expect(() => unpack(broken, 'tar.gz', LIMITS)).toThrow(/could not be decompressed/)
  })

  it('refuses a tar that expands beyond the total bound', () => {
    const archive = tar([{ name: 'a.md', body: 'x'.repeat(200) }])
    expect(() => unpack(archive, 'tar', { ...LIMITS, maxTotalBytes: 128 })).toThrow(/total size limit/)
  })

  it('refuses a tar member past the per-file bound', () => {
    const archive = tar([{ name: 'a.md', body: 'x'.repeat(200) }])
    expect(() => unpack(archive, 'tar', { ...LIMITS, maxFileBytes: 64 })).toThrow(/too large/)
  })

  it('refuses a tar holding more members than allowed', () => {
    const archive = tar([
      { name: 'a.md', body: 'x' },
      { name: 'b.md', body: 'x' },
    ])
    expect(() => unpack(archive, 'tar', { ...LIMITS, maxEntries: 1 })).toThrow(/too many members/)
  })

  it('reads a tar member addressed through the ustar prefix field', () => {
    const archive = tar([{ name: 'a.md', body: 'x' }])
    archive.set(encoder.encode('a.md'), 0)
    archive.set(encoder.encode('nested'), 345)
    const entries = unpack(archive, 'tar', LIMITS)
    expect(entries.map(entry => entry.path)).toEqual(['nested/a.md'])
  })

  it('refuses a member whose declared size overruns the archive', () => {
    const archive = tar([{ name: 'a.md', body: 'x' }])
    // A size field far past the per-file bound: refused on the header, before
    // any slice into the buffer can be taken.
    archive.set(encoder.encode('00077777777\0'), 124)
    expect(() => unpack(archive, 'tar', LIMITS)).toThrow(/too large/)
  })

  it('reads an empty size field as a member of no bytes', () => {
    const archive = tar([{ name: 'empty.md', body: '' }])
    // An all-NUL size field, the shape a sparse writer emits.
    archive.fill(0, 124, 136)
    expect(unpack(archive, 'tar', LIMITS)[0]).toMatchObject({ path: 'empty.md' })
  })

  it('stops when the archive ends without trailing blocks', () => {
    const full = tar([{ name: 'a.md', body: 'x' }])
    // Drop the two end-of-archive blocks so the loop exits on its own guard
    // rather than on a zero header.
    const trimmed = full.subarray(0, full.length - 1024)
    expect(unpack(trimmed, 'tar', LIMITS).map(entry => entry.path)).toEqual(['a.md'])
  })

  it('treats a zero size field as an empty member', () => {
    const archive = tar([{ name: 'empty.md', body: '' }])
    expect(unpack(archive, 'tar', LIMITS)[0]).toMatchObject({ path: 'empty.md' })
  })
})

describe('GitHub listing branches', () => {
  function listingTransport(rows: unknown, extra: Record<string, { body: Uint8Array | string }> = {}): ImportFetch {
    return fakeFetch({
      'https://api.github.com/repos/o/r/contents/': { body: JSON.stringify(rows) },
      ...extra,
    })
  }

  it('skips rows that carry no path and rows that are neither file nor dir', async () => {
    const transport = listingTransport([
      { type: 'file', size: 1 },
      { type: 'submodule', path: 'sub', size: 1 },
      { type: 'file', path: 'SKILL.md', size: 40, download_url: 'https://raw.test/SKILL.md' },
    ], { 'https://raw.test/SKILL.md': { body: '---\nname: a\ndescription: d\n---\n' } })
    const plan = await planImport({ source: 'o/r' }, transport, LIMITS)
    expect(plan.files.map(file => file.path)).toEqual(['SKILL.md'])
  })

  it('derives a download URL when the listing omits one', async () => {
    const transport = listingTransport(
      [{ type: 'file', path: 'SKILL.md', size: 40 }],
      { 'https://raw.githubusercontent.com/o/r/HEAD/SKILL.md': { body: '---\nname: a\ndescription: d\n---\n' } },
    )
    const plan = await planImport({ source: 'o/r' }, transport, LIMITS)
    expect(plan.files.map(file => file.path)).toEqual(['SKILL.md'])
  })

  it('refuses a listed file whose declared size is already past the bound', async () => {
    const transport = listingTransport([{ type: 'file', path: 'SKILL.md', size: 999999, download_url: 'https://raw.test/x' }])
    await expect(planImport({ source: 'o/r' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('refuses a listing whose files together exceed the total bound', async () => {
    const rows = [
      { type: 'file', path: 'a.bin', size: 4000, download_url: 'https://raw.test/a' },
      { type: 'file', path: 'b.bin', size: 4000, download_url: 'https://raw.test/b' },
    ]
    const transport = listingTransport(rows, {
      'https://raw.test/a': { body: 'a'.repeat(4000) },
      'https://raw.test/b': { body: 'b'.repeat(4000) },
    })
    await expect(planImport({ source: 'o/r' }, transport, { ...LIMITS, maxTotalBytes: 6000 }))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('refuses files whose actual downloads together exceed the total bound', async () => {
    // Each listing row declares a size within the bound; what arrives is not.
    const rows = [
      { type: 'file', path: 'a.bin', size: 10, download_url: 'https://raw.test/a' },
      { type: 'file', path: 'b.bin', size: 10, download_url: 'https://raw.test/b' },
    ]
    const transport = fakeFetch({
      'https://api.github.com/repos/o/r/contents/': { body: JSON.stringify(rows) },
      'https://raw.test/a': { body: 'a'.repeat(60) },
      'https://raw.test/b': { body: 'b'.repeat(60) },
    })
    await expect(planImport({ source: 'o/r' }, transport, { ...LIMITS, maxTotalBytes: 100 }))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('refuses a listing with more files than allowed', async () => {
    const rows = [
      { type: 'file', path: 'a.md', size: 1, download_url: 'https://raw.test/a' },
      { type: 'file', path: 'b.md', size: 1, download_url: 'https://raw.test/b' },
    ]
    const transport = listingTransport(rows, {
      'https://raw.test/a': { body: 'x' },
      'https://raw.test/b': { body: 'y' },
    })
    await expect(planImport({ source: 'o/r' }, transport, { ...LIMITS, maxEntries: 1 }))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('refuses a listing that is not an array', async () => {
    const transport = listingTransport({ message: 'Not Found' })
    await expect(planImport({ source: 'o/r' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('refuses a listing row that leaves the requested subdirectory', async () => {
    const transport = fakeFetch({
      'https://api.github.com/repos/o/r/contents/s': {
        body: JSON.stringify([{ type: 'file', path: 'other/SKILL.md', size: 1, download_url: 'https://raw.test/x' }]),
      },
    })
    await expect(planImport({ source: 'o/r/s' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('reports a non-ok answer from the listing endpoint', async () => {
    const transport = fakeFetch({ 'https://api.github.com/repos/o/r/contents/': { body: 'nope', status: 500 } })
    await expect(planImport({ source: 'o/r' }, transport, LIMITS))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreachable' })
  })
})

describe('final branch sweep', () => {
  it('reads a ref from the owner/repo shorthand', () => {
    expect(parseGitHubSource('o/r@v1.2')).toMatchObject({ owner: 'o', repo: 'r', ref: 'v1.2' })
    expect(parseGitHubSource('o/r')).toEqual({ owner: 'o', repo: 'r', path: '' })
  })

  it('detects an archive whose response carries no content type', async () => {
    const transport = fakeFetch({
      'https://example.com/skill.zip': { body: zip({ 'SKILL.md': '---\nname: a\ndescription: d\n---\n' }) },
    })
    const plan = await planImport({ source: 'https://example.com/skill.zip' }, transport, LIMITS)
    expect(plan.files.map(file => file.path)).toEqual(['SKILL.md'])
  })

  it('requests a ref when the source names one', async () => {
    const transport = fakeFetch({
      'https://api.github.com/repos/o/r/contents/?ref=main': {
        body: JSON.stringify([{ type: 'file', path: 'SKILL.md', size: 40, download_url: 'https://raw.test/SKILL.md' }]),
      },
      'https://raw.test/SKILL.md': { body: '---\nname: a\ndescription: d\n---\n' },
    })
    const plan = await planImport({ source: 'https://github.com/o/r/tree/main' }, transport, LIMITS)
    expect(plan.files.map(file => file.path)).toEqual(['SKILL.md'])
  })

  it('treats a listing row without a numeric size as empty', async () => {
    const transport = fakeFetch({
      'https://api.github.com/repos/o/r/contents/': {
        body: JSON.stringify([{ type: 'file', path: 'SKILL.md', download_url: 'https://raw.test/SKILL.md' }]),
      },
      'https://raw.test/SKILL.md': { body: '---\nname: a\ndescription: d\n---\n' },
    })
    const plan = await planImport({ source: 'o/r' }, transport, LIMITS)
    expect(plan.files).toHaveLength(1)
  })

  it('refuses a listing whose declared sizes together exceed the total bound', async () => {
    const rows = [
      { type: 'file', path: 'a.bin', size: 4000, download_url: 'https://raw.test/a' },
      { type: 'file', path: 'b.bin', size: 4000, download_url: 'https://raw.test/b' },
    ]
    const transport = fakeFetch({
      'https://api.github.com/repos/o/r/contents/': { body: JSON.stringify(rows) },
      'https://raw.test/a': { body: 'a'.repeat(4000) },
    })
    // Refused once the running total crosses the bound, before the second
    // download is attempted.
    await expect(planImport({ source: 'o/r' }, transport, { ...LIMITS, maxTotalBytes: 6000 }))
      .rejects.toMatchObject({ code: 'skill-admin/import-unreadable' })
  })

  it('stages into a pool whose capacity is zero', () => {
    // The eviction loop has nothing to evict, so its guard decides; the
    // staged entry is still addressable until the caller takes it.
    const staging = new ImportStaging(0)
    const id = staging.stage({ files: [], origin: 'x', rootPath: '/r' })
    expect(staging.take(id)).toMatchObject({ origin: 'x' })
  })

  it('reads a stored (undeclared-size) zip member', () => {
    const entries = unpack(zipSync({ 'SKILL.md': encoder.encode('# demo') }, { level: 0 }), 'zip', LIMITS)
    expect(entries.map(entry => entry.path)).toEqual(['SKILL.md'])
  })

  it('stops at a member whose declared size overruns the remaining bytes', () => {
    const archive = tar([{ name: 'a.md', body: 'x' }])
    // A size within the per-file bound but past the end of the buffer.
    archive.set(encoder.encode('00000004000\0'), 124)
    const entries = unpack(archive, 'tar', LIMITS)
    expect(entries[0]!.bytes.byteLength).toBeLessThanOrEqual(archive.length)
  })

  it('refuses a base-256 size field', () => {
    const archive = tar([{ name: 'a.md', body: 'x' }])
    archive[124] = 0x80
    expect(() => unpack(archive, 'tar', LIMITS)).toThrow(/base-256/)
  })

  it('refuses a tar whose members together exceed the total bound', () => {
    const archive = tar([
      { name: 'a.md', body: 'x'.repeat(200) },
      { name: 'b.md', body: 'y'.repeat(200) },
    ])
    expect(() => unpack(archive, 'tar', { ...LIMITS, maxTotalBytes: 300 })).toThrow(/total size limit/)
  })
})

describe('directories without an entry point', () => {
  it('ignores a directory that holds no SKILL.md', async () => {
    const root = await scratch()
    await mkdir(join(root, 'not-a-skill'), { recursive: true })
    const transport = fakeFetch({})
    const gateway = await harness(root, transport)
    expect((await gateway.list({})).roots[0]!.entries).toEqual([])
  })
})
