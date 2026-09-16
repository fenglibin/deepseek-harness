/**
 * Behavior specs for the revert path that touches the disk: what a revert does
 * to a real file, including one carrying changes the session did not make.
 * @module
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { revertContent } from '@deepseek-ai/dsh-session-file-revisions'
import type { FileRevision } from '@deepseek-ai/dsh-session-file-revisions/types'
import { containPath, EscapeError } from '../src/containment.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-revisions-'))
})

afterEach(async () => {
  await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }))
})

/**
 * Apply one revision's revert to the real file, mirroring the controller's
 * decision so the disk effect is what is under test.
 * @param revision - the captured revision.
 * @returns the outcome the controller would report.
 */
async function applyRevert(revision: FileRevision): Promise<'reverted' | 'unchanged' | 'conflict' | 'missing'> {
  const contained = await containPath(root, revision.path)
  let current: string | null
  try {
    current = await readFile(contained, 'utf8')
  } catch {
    return 'missing'
  }
  if (revision.baseline === null) {
    await import('node:fs/promises').then(fs => fs.rm(contained))
    return 'reverted'
  }
  const result = revertContent(revision.baseline, revision.endState, current)
  if (result.applied === 'none') return 'conflict'
  if (result.content === current) return 'unchanged'
  await writeFile(contained, result.content, 'utf8')
  return 'reverted'
}

function revision(path: string, baseline: string | null, endState: string): FileRevision {
  return { path, baseline, endState, operation: 'write', firstSeq: 1, lastSeq: 1 }
}

describe('revert against real files', () => {
  it('restores the baseline when nothing else touched the file', async () => {
    const path = join(root, 'a.txt')
    await writeFile(path, 'a\nB\nc\n', 'utf8')
    expect(await applyRevert(revision(path, 'a\nb\nc\n', 'a\nB\nc\n'))).toBe('reverted')
    expect(await readFile(path, 'utf8')).toBe('a\nb\nc\n')
  })

  it('keeps an edit made outside the session', async () => {
    const path = join(root, 'b.txt')
    await writeFile(path, 'a\nB\nc\nd\nE-USER\n', 'utf8')
    const outcome = await applyRevert(revision(path, 'a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n'))
    expect(outcome).toBe('reverted')
    expect(await readFile(path, 'utf8')).toBe('a\nb\nc\nd\nE-USER\n')
  })

  it('reports a conflict and leaves the file alone when the same line was overwritten', async () => {
    const path = join(root, 'c.txt')
    const disk = 'X-USER\ny\nz\n'
    await writeFile(path, disk, 'utf8')
    const outcome = await applyRevert(revision(path, 'x\ny\nz\n', 'X-AGENT\ny\nz\n'))
    expect(outcome).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe(disk)
  })

  it('reports missing when the file is gone', async () => {
    const path = join(root, 'gone.txt')
    expect(await applyRevert(revision(path, 'a\n', 'b\n'))).toBe('missing')
  })
})

describe('containPath', () => {
  it('accepts a path inside the root', async () => {
    const path = join(root, 'inside.txt')
    await writeFile(path, 'x', 'utf8')
    await expect(containPath(root, path)).resolves.toContain('inside.txt')
  })

  it('refuses a path outside the root', async () => {
    await expect(containPath(root, join(root, '..', 'outside.txt'))).rejects.toBeInstanceOf(EscapeError)
  })
})
