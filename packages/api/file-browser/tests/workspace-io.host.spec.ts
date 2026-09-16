/**
 * Workspace-scoped filesystem behavior of the file browser: containment
 * (symlink escapes included), the content arms that decide what may be edited,
 * the version guard, and the create/rename/delete/search operations. The
 * controller layer above it only translates these outcomes onto the wire, so
 * the storage contract is asserted here.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SEARCH_LIMIT,
  WorkspaceIoError,
  createEntry,
  deleteEntry,
  listDirectory,
  readFileContent,
  readImageBytes,
  renameEntry,
  SNIFF_BYTES,
  searchNames,
  writeFileContent,
  type WorkspaceIoLimits,
} from '../src/workspace-io.ts'

const limits: WorkspaceIoLimits = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  listLimit: DEFAULT_LIST_LIMIT,
  searchLimit: DEFAULT_SEARCH_LIMIT,
}

const roots: string[] = []

afterEach(() => {
  roots.splice(0)
})

/** One workspace root with a name that sorts after the fixtures created inside it. */
function workspace(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-file-browser-')))
  roots.push(root)
  return root
}

/** The bytes-route URL composer the controller supplies to `readFileContent`. */
const assetUrl = (relativePath: string): string => `/api/file.asset?path=${relativePath}`

/** Assert one operation refuses with a specific structured code. */
async function expectRefusal(operation: Promise<unknown>, code: WorkspaceIoError['code']): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(WorkspaceIoError)
  await operation.catch((error: unknown) => {
    expect((error as WorkspaceIoError).code).toBe(code)
  })
}

describe('listing', () => {
  it('reports directories before files, each name-sorted', async () => {
    const root = workspace()
    writeFileSync(join(root, 'b.txt'), 'b')
    writeFileSync(join(root, 'a.txt'), 'a')
    mkdirSync(join(root, 'zdir'))
    mkdirSync(join(root, 'adir'))
    const listing = await listDirectory(root, undefined, false, limits)
    expect(listing.path).toBe('')
    expect(listing.entries.map(entry => entry.name)).toEqual(['adir', 'zdir', 'a.txt', 'b.txt'])
    expect(listing.entries[0]?.kind).toBe('directory')
    expect(listing.entries[2]?.kind).toBe('file')
    expect(listing.truncated).toBe(false)
  })

  it('hides dot-prefixed entries and heavy directories by default', async () => {
    const root = workspace()
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'src'))
    const hidden = await listDirectory(root, undefined, false, limits)
    expect(hidden.entries.map(entry => entry.name)).toEqual(['src'])
  })

  it('reveals hidden entries and heavy directories on request', async () => {
    const root = workspace()
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'src'))
    const shown = await listDirectory(root, undefined, true, limits)
    expect(shown.entries.map(entry => entry.name)).toEqual(['.git', 'node_modules', 'src'])
  })

  it('lists a subdirectory by its workspace-relative path', async () => {
    const root = workspace()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'main.ts'), 'export {}')
    const listing = await listDirectory(root, 'src', false, limits)
    expect(listing.path).toBe('src')
    expect(listing.entries.map(entry => entry.path)).toEqual(['src/main.ts'])
    expect(listing.entries[0]?.size).toBe(9)
  })

  it('reports truncation past the listing bound', async () => {
    const root = workspace()
    for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `f${String(index)}.txt`), 'x')
    const listing = await listDirectory(root, undefined, false, { ...limits, listLimit: 3 })
    expect(listing.entries).toHaveLength(3)
    expect(listing.truncated).toBe(true)
  })

  it('leaves a broken symlink out instead of showing a row that always fails', async () => {
    const root = workspace()
    symlinkSync(join(root, 'gone.txt'), join(root, 'dangling'))
    const listing = await listDirectory(root, undefined, false, limits)
    expect(listing.entries.map(entry => entry.name)).toEqual([])
  })

  it('refuses a missing directory and a path that names a file', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'a')
    await expectRefusal(listDirectory(root, 'nope', false, limits), 'not-found')
    await expectRefusal(listDirectory(root, 'a.txt', false, limits), 'unreadable')
  })
})

describe('containment', () => {
  it('refuses a relative path that climbs out lexically', async () => {
    const root = workspace()
    await expectRefusal(listDirectory(root, '../..', false, limits), 'outside-workspace')
    await expectRefusal(readFileContent(root, '../../etc/passwd', limits, assetUrl), 'outside-workspace')
  })

  it('refuses an absolute path', async () => {
    const root = workspace()
    await expectRefusal(listDirectory(root, '/etc', false, limits), 'outside-workspace')
  })

  it('refuses a symlink that points outside the workspace', async () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.txt'), 'classified')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    await expectRefusal(readFileContent(root, 'link.txt', limits, assetUrl), 'outside-workspace')
    await expectRefusal(writeFileContent(root, 'link.txt', 'overwritten', undefined, limits), 'outside-workspace')
  })

  it('refuses a symlinked directory that points outside the workspace', async () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.txt'), 'classified')
    symlinkSync(outside, join(root, 'escape'))
    await expectRefusal(listDirectory(root, 'escape', false, limits), 'outside-workspace')
  })

  it('allows a symlink that stays inside the workspace', async () => {
    const root = workspace()
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'a.txt'), 'inside')
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    const content = await readFileContent(root, 'alias/a.txt', limits, assetUrl)
    expect(content.kind).toBe('text')
    if (content.kind !== 'text') throw new Error('expected text')
    expect(content.text).toBe('inside')
    expect(content.size).toBe(6)
    expect(content.version).toMatch(/^\d+(?:\.\d+)?:\d+$/)
  })
})

describe('reading content', () => {
  it('reads a text file with a version token', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'hello')
    const content = await readFileContent(root, 'a.txt', limits, assetUrl)
    expect(content.kind).toBe('text')
    if (content.kind !== 'text') throw new Error('expected text')
    expect(content.text).toBe('hello')
    expect(content.size).toBe(5)
    expect(content.version).toMatch(/^\d+(?:\.\d+)?:\d+$/)
  })

  it('classifies each supported image kind by extension', async () => {
    const root = workspace()
    for (const [name, mediaType] of [
      ['a.png', 'image/png'], ['a.jpg', 'image/jpeg'], ['a.jpeg', 'image/jpeg'],
      ['a.webp', 'image/webp'], ['a.gif', 'image/gif'],
    ] as const) {
      writeFileSync(join(root, name), 'not-really-an-image')
      const content = await readFileContent(root, name, limits, assetUrl)
      expect(content).toEqual({ kind: 'image', mediaType, size: 19, url: assetUrl(name) })
    }
  })

  it('classifies a NUL-bearing file as binary', async () => {
    const root = workspace()
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42]))
    expect(await readFileContent(root, 'blob.bin', limits, assetUrl)).toEqual({ kind: 'binary', size: 3 })
  })

  it('reads a text file whose sample boundary falls inside a multi-byte character', async () => {
    const root = workspace()
    // The regression this pins: the content sample is a fixed-width prefix, so
    // a strict decode reported malformed input whenever the cut landed inside a
    // character — an ordinary UTF-8 Markdown file was shown as binary. Three
    // bytes of CJK straddle byte 8192 here by construction.
    const filler = 'a'.repeat(SNIFF_BYTES - 2)
    writeFileSync(join(root, 'cjk.md'), `${filler}中文内容\n`)
    const content = await readFileContent(root, 'cjk.md', limits, assetUrl)
    expect(content.kind).toBe('text')
    if (content.kind !== 'text') throw new Error('expected text')
    expect(content.text).toBe(`${filler}中文内容\n`)
  })

  it('reads a text file whose sample boundary splits the first byte of a character', async () => {
    const root = workspace()
    // The cut can also land immediately after a lead byte, leaving 1 or 2
    // continuation bytes outside the sample.
    const filler = 'a'.repeat(SNIFF_BYTES - 1)
    writeFileSync(join(root, 'cjk2.md'), `${filler}中\n`)
    expect((await readFileContent(root, 'cjk2.md', limits, assetUrl)).kind).toBe('text')
  })

  it('still classifies a truncated multi-byte sequence as binary', async () => {
    const root = workspace()
    // An incomplete sequence at end-of-file is malformed, not a boundary cut:
    // streaming decode tolerates the latter, never the former.
    writeFileSync(join(root, 'truncated.bin'), Buffer.concat([
      Buffer.from('ok '), Buffer.from([0xe4, 0xb8]),
    ]))
    expect((await readFileContent(root, 'truncated.bin', limits, assetUrl)).kind).toBe('binary')
  })

  it('classifies an invalid UTF-8 file as binary', async () => {
    const root = workspace()
    writeFileSync(join(root, 'bad.bin'), Buffer.from([0xff, 0xfe, 0xfd]))
    expect(await readFileContent(root, 'bad.bin', limits, assetUrl)).toEqual({ kind: 'binary', size: 3 })
  })

  it('reports a file over the bound as too-large without reading it', async () => {
    const root = workspace()
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(64))
    const content = await readFileContent(root, 'big.txt', { ...limits, maxFileBytes: 16 }, assetUrl)
    expect(content).toEqual({ kind: 'too-large', size: 64, limit: 16 })
  })

  it('refuses a missing file and a directory spelled as a file', async () => {
    const root = workspace()
    mkdirSync(join(root, 'adir'))
    await expectRefusal(readFileContent(root, 'nope.txt', limits, assetUrl), 'not-found')
    await expectRefusal(readFileContent(root, 'adir', limits, assetUrl), 'unsupported')
  })
})

describe('writing', () => {
  it('writes content atomically and reports the new version', async () => {
    const root = workspace()
    const version = await writeFileContent(root, 'a.txt', 'first', undefined, limits)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('first')
    expect(version).toMatch(/^\d+(?:\.\d+)?:\d+$/)
  })

  it('accepts a guarded write when the version still matches', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'first')
    const read = await readFileContent(root, 'a.txt', limits, assetUrl)
    if (read.kind !== 'text') throw new Error('expected text')
    await writeFileContent(root, 'a.txt', 'second', read.version, limits)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('second')
  })

  it('refuses a guarded write once the file changed on disk', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'first')
    const read = await readFileContent(root, 'a.txt', limits, assetUrl)
    if (read.kind !== 'text') throw new Error('expected text')
    // Another writer replaces the file, which is exactly what the guard exists for.
    writeFileSync(join(root, 'a.txt'), 'changed by someone else')
    await expectRefusal(writeFileContent(root, 'a.txt', 'mine', read.version, limits), 'stale')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('changed by someone else')
  })

  it('refuses a guarded write against a file that is not there', async () => {
    const root = workspace()
    await expectRefusal(writeFileContent(root, 'gone.txt', 'x', '1:2', limits), 'stale')
  })

  it('refuses content over the bound', async () => {
    const root = workspace()
    await expectRefusal(
      writeFileContent(root, 'a.txt', 'x'.repeat(64), undefined, { ...limits, maxFileBytes: 16 }),
      'unsupported',
    )
  })

  it('refuses to write over a directory', async () => {
    const root = workspace()
    mkdirSync(join(root, 'adir'))
    await expectRefusal(writeFileContent(root, 'adir', 'x', undefined, limits), 'unsupported')
  })

  it('leaves no temporary file behind on a refused write', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'first')
    const read = await readFileContent(root, 'a.txt', limits, assetUrl)
    if (read.kind !== 'text') throw new Error('expected text')
    await writeFileContent(root, 'a.txt', 'second', read.version, limits).catch(() => undefined)
    const listing = await listDirectory(root, undefined, true, limits)
    expect(listing.entries.map(entry => entry.name)).toEqual(['a.txt'])
  })
})

describe('create, rename, and delete', () => {
  it('creates an empty file in the workspace root', async () => {
    const root = workspace()
    const path = await createEntry(root, undefined, 'new.txt', 'file')
    expect(path).toBe('new.txt')
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('')
  })

  it('creates a directory inside a subdirectory', async () => {
    const root = workspace()
    mkdirSync(join(root, 'src'))
    const path = await createEntry(root, 'src', 'nested', 'directory')
    expect(path).toBe('src/nested')
    expect(existsSync(join(root, 'src', 'nested'))).toBe(true)
  })

  it('refuses a name that is not a single path segment', async () => {
    const root = workspace()
    for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b']) {
      await expectRefusal(createEntry(root, undefined, name, 'file'), 'invalid-name')
    }
  })

  it('refuses a name already taken', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'x')
    await expectRefusal(createEntry(root, undefined, 'a.txt', 'file'), 'exists')
  })

  it('refuses a create inside a missing directory', async () => {
    const root = workspace()
    await expectRefusal(createEntry(root, 'nope', 'a.txt', 'file'), 'not-found')
  })

  it('renames a file and keeps its content', async () => {
    const root = workspace()
    writeFileSync(join(root, 'old.txt'), 'payload')
    const path = await renameEntry(root, 'old.txt', 'new.txt')
    expect(path).toBe('new.txt')
    expect(existsSync(join(root, 'old.txt'))).toBe(false)
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('payload')
  })

  it('refuses a rename onto an existing entry and a rename of a missing one', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'b.txt'), 'b')
    await expectRefusal(renameEntry(root, 'a.txt', 'b.txt'), 'exists')
    await expectRefusal(renameEntry(root, 'gone.txt', 'c.txt'), 'not-found')
  })

  it('refuses an invalid rename target name', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'a')
    await expectRefusal(renameEntry(root, 'a.txt', '../escape.txt'), 'invalid-name')
  })

  it('deletes a file', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'a')
    await deleteEntry(root, 'a.txt')
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })

  it('deletes a directory together with its contents', async () => {
    const root = workspace()
    mkdirSync(join(root, 'dir', 'inner'), { recursive: true })
    writeFileSync(join(root, 'dir', 'inner', 'a.txt'), 'a')
    await deleteEntry(root, 'dir')
    expect(existsSync(join(root, 'dir'))).toBe(false)
  })

  it('refuses to delete the workspace root itself', async () => {
    const root = workspace()
    await expectRefusal(deleteEntry(root, ''), 'unsupported')
  })

  it('refuses to delete a missing entry', async () => {
    const root = workspace()
    await expectRefusal(deleteEntry(root, 'gone.txt'), 'not-found')
  })
})

describe('name search', () => {
  it('finds a file nested several levels deep', async () => {
    const root = workspace()
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'c', 'needle.ts'), 'x')
    const result = await searchNames(root, 'needle', limits, { showHidden: false })
    expect(result.matches).toEqual([{ path: 'a/b/c/needle.ts', kind: 'file' }])
    expect(result.truncated).toBe(false)
  })

  it('matches names case-insensitively', async () => {
    const root = workspace()
    writeFileSync(join(root, 'Needle.TS'), 'x')
    const result = await searchNames(root, 'needle', limits, { showHidden: false })
    expect(result.matches.map(match => match.path)).toEqual(['Needle.TS'])
  })

  it('never matches file content', async () => {
    const root = workspace()
    writeFileSync(join(root, 'plain.txt'), 'the needle is inside this file')
    const result = await searchNames(root, 'needle', limits, { showHidden: false })
    expect(result.matches).toEqual([])
  })

  it('matches directories as well as files', async () => {
    const root = workspace()
    mkdirSync(join(root, 'needle-dir'))
    const result = await searchNames(root, 'needle', limits, { showHidden: false })
    expect(result.matches).toEqual([{ path: 'needle-dir', kind: 'directory' }])
  })

  it('reports truncation past the result bound', async () => {
    const root = workspace()
    for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `needle${String(index)}.txt`), 'x')
    const result = await searchNames(root, 'needle', { ...limits, searchLimit: 2 }, { showHidden: false })
    expect(result.matches).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('matches nothing for a blank query', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'x')
    expect(await searchNames(root, '   ', limits, { showHidden: false })).toEqual({ matches: [], truncated: false })
  })

  it('skips hidden trees unless asked', async () => {
    const root = workspace()
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'needle.js'), 'x')
    expect((await searchNames(root, 'needle', limits, { showHidden: false })).matches).toEqual([])
    expect((await searchNames(root, 'needle', limits, { showHidden: true })).matches)
      .toEqual([{ path: 'node_modules/needle.js', kind: 'file' }])
  })
})

describe('image bytes', () => {
  it('returns the media type and raw bytes for a supported image', async () => {
    const root = workspace()
    writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const asset = await readImageBytes(root, 'pic.png', 1024)
    expect(asset.mediaType).toBe('image/png')
    expect([...asset.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('refuses a name that is not an image kind', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'x')
    await expectRefusal(readImageBytes(root, 'a.txt', 1024), 'unsupported')
  })

  it('refuses a path outside the workspace', async () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.png'), 'bytes')
    symlinkSync(join(outside, 'secret.png'), join(root, 'link.png'))
    await expectRefusal(readImageBytes(root, 'link.png', 1024), 'outside-workspace')
  })

  it('refuses an image over the byte ceiling', async () => {
    const root = workspace()
    writeFileSync(join(root, 'big.png'), Buffer.alloc(64))
    await expectRefusal(readImageBytes(root, 'big.png', 16), 'unsupported')
  })

  it('refuses a missing image', async () => {
    const root = workspace()
    await expectRefusal(readImageBytes(root, 'gone.png', 1024), 'not-found')
  })
})
