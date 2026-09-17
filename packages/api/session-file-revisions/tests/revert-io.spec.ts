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
import { lineCounts, retiresRevision } from '../src/index.ts'
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
  // An uncaptured prior content is not a create: the controller refuses rather
  // than deleting a file this session may never have made.
  if (revision.origin === 'unknown') return 'conflict'
  if (revision.origin === 'absent') {
    if (current !== revision.endState) return 'conflict'
    await import('node:fs/promises').then(fs => fs.rm(contained))
    return 'reverted'
  }
  const result = revertContent(revision.baseline, revision.endState, current)
  if (result.applied === 'none') return 'conflict'
  if (result.content === current) return 'unchanged'
  await writeFile(contained, result.content, 'utf8')
  return 'reverted'
}

function revision(
  path: string,
  baseline: string | null,
  endState: string,
  origin: 'existing' | 'absent' | 'unknown' = baseline === null ? 'absent' : 'existing',
): FileRevision {
  return {
    path, baseline, origin, endState, operation: 'write',
    firstOrder: { session: 's' as never, at: 1, seq: 1 },
    lastOrder: { session: 's' as never, at: 1, seq: 1 },
  }
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

  it('deletes a file the session created when it still holds the written content', async () => {
    const path = join(root, 'made.txt')
    await writeFile(path, 'fresh\n', 'utf8')
    expect(await applyRevert(revision(path, null, 'fresh\n'))).toBe('reverted')
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('refuses to delete a created file whose content someone else changed', async () => {
    const path = join(root, 'made-then-edited.txt')
    const disk = 'SOMEONE-ELSE\n'
    await writeFile(path, disk, 'utf8')
    expect(await applyRevert(revision(path, null, 'fresh\n'))).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe(disk)
  })

  it('refuses to delete an OVERWRITE whose prior content was never captured', async () => {
    // The storage backend reports a null `before` for an overwrite at or above
    // its presentation bound (and for binary/non-UTF-8/unreadable content), so
    // a bulky overwrite looks exactly like a create in the tool result. The
    // file existed before this session touched it, and a revert must not
    // destroy it on that ambiguity.
    const path = join(root, 'big-existing.txt')
    const disk = 'x'.repeat(12 * 1024 * 1024)
    await writeFile(path, disk, 'utf8')
    expect(await applyRevert(revision(path, null, 'smalled\n', 'unknown'))).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe(disk)
  })
})

describe('which revert outcomes retire the path record', () => {
  it('retires only a completed revert', () => {
    // A conflict or a missing file still holds this session's change, so
    // dropping its record there would lose the only account of what the session
    // did. An unchanged revert did not happen at all, which leaves the record
    // as the sole description of the file's current state.
    expect(retiresRevision('reverted')).toBe(true)
    expect(retiresRevision('conflict')).toBe(false)
    expect(retiresRevision('missing')).toBe(false)
    expect(retiresRevision('unchanged')).toBe(false)
  })
})

describe('line counts the list reports', () => {
  it('reports zero counts for an uncaptured baseline rather than a whole-file addition', () => {
    // `unknown` has no baseline to compare against, so claiming the end state's
    // lines as added would invent a change the capture cannot support.
    expect(lineCounts(revision('/w/x', null, 'a\nb\nc\n', 'unknown'))).toEqual({ added: 0, removed: 0 })
  })

  it('counts a created file as pure additions', () => {
    expect(lineCounts(revision('/w/x', null, 'a\nb\n', 'absent'))).toEqual({ added: 2, removed: 0 })
  })

  it('counts both sides for an existing baseline', () => {
    expect(lineCounts(revision('/w/x', 'old\n', 'new\nlonger\n', 'existing')))
      .toEqual({ added: 2, removed: 1 })
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
