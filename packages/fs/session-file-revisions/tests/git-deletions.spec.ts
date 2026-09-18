/**
 * Behavior specs for deletion observation: which paths a workspace reports as
 * deleted, and which of those belong to the session that asked.
 *
 * The parse and baseline specs are pure. The scan specs run against a REAL git
 * repository in a temp directory, because the thing worth proving is that git's
 * own output shape is read correctly — a fake would only assert my assumption
 * about that shape, which is the assumption under test.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { DeletionBaseline, parseDeletedPaths, scanDeletedPaths } from '../src/git-deletions.ts'

describe('parseDeletedPaths', () => {
  it('reads a worktree deletion', () => {
    // `git status --porcelain -z` writes `<XY> <path>\0`: two status columns, a
    // space, then the path.
    expect(parseDeletedPaths(' D src/a.txt\0')).toEqual(['src/a.txt'])
  })

  it('reads a staged deletion', () => {
    expect(parseDeletedPaths('D  src/a.txt\0')).toEqual(['src/a.txt'])
  })

  it('ignores modified, added, and untracked entries', () => {
    expect(parseDeletedPaths(' M src/a.txt\0A  src/b.txt\0?? src/c.txt\0')).toEqual([])
  })

  it('reads several deletions in order', () => {
    expect(parseDeletedPaths(' D a.txt\0D  b.txt\0')).toEqual(['a.txt', 'b.txt'])
  })

  it('skips the source path of a rename', () => {
    // A rename occupies TWO NUL-terminated records: the first carries the status
    // and the destination, the second the bare source path. Reading the second
    // as a status line would invent an entry.
    expect(parseDeletedPaths('R  new.txt\0old.txt\0')).toEqual([])
  })

  it('keeps a deletion that follows a rename', () => {
    expect(parseDeletedPaths('R  new.txt\0old.txt\0 D gone.txt\0')).toEqual(['gone.txt'])
  })

  it('keeps a path containing spaces verbatim', () => {
    expect(parseDeletedPaths(' D my file.txt\0')).toEqual(['my file.txt'])
  })

  it('ignores the trailing empty record', () => {
    expect(parseDeletedPaths(' D a.txt\0')).toEqual(['a.txt'])
  })

  it('reads nothing from empty output', () => {
    expect(parseDeletedPaths('')).toEqual([])
  })
})

describe('DeletionBaseline', () => {
  it('treats a path deleted before the baseline as not this session\'s doing', () => {
    const baseline = new DeletionBaseline()
    baseline.establish('s1', ['already-gone.txt'])
    expect(baseline.since('s1', ['already-gone.txt'])).toEqual([])
  })

  it('reports a path that becomes deleted after the baseline', () => {
    const baseline = new DeletionBaseline()
    baseline.establish('s1', [])
    expect(baseline.since('s1', ['a.txt'])).toEqual(['a.txt'])
  })

  it('reports only the new deletion when an old one is still there', () => {
    const baseline = new DeletionBaseline()
    baseline.establish('s1', ['old.txt'])
    expect(baseline.since('s1', ['old.txt', 'new.txt'])).toEqual(['new.txt'])
  })

  it('reports nothing on its first scan and never treats that scan as a baseline', () => {
    // The first `since` call with no prior baseline establishes an EMPTY one, so
    // nothing seen for the first time can be attributed to the session.
    const baseline = new DeletionBaseline()
    expect(baseline.since('s1', ['a.txt'])).toEqual([])
    expect(baseline.since('s1', ['a.txt', 'b.txt'])).toEqual(['b.txt'])
  })

  it('does not move the baseline when established again', () => {
    // Re-establishing after a deletion would fold that deletion into the
    // baseline and stop reporting it, hiding a file the reader should see.
    const baseline = new DeletionBaseline()
    baseline.establish('s1', [])
    baseline.establish('s1', ['a.txt'])
    expect(baseline.since('s1', ['a.txt'])).toEqual(['a.txt'])
  })

  it('knows whether a baseline exists', () => {
    const baseline = new DeletionBaseline()
    expect(baseline.known('s1')).toBe(false)
    baseline.establish('s1', [])
    expect(baseline.known('s1')).toBe(true)
  })

  it('keeps sessions independent', () => {
    const baseline = new DeletionBaseline()
    baseline.establish('s1', [])
    expect(baseline.since('s2', ['a.txt'])).toEqual([])
    expect(baseline.since('s1', ['a.txt'])).toEqual(['a.txt'])
  })

  it('forgets one session only', () => {
    const baseline = new DeletionBaseline()
    baseline.establish('s1', [])
    baseline.forget('s1')
    expect(baseline.known('s1')).toBe(false)
  })
})

describe('scanDeletedPaths', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-deletions-'))
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    }
    git('init', '-q', '.')
    await writeFile(join(root, 'tracked.txt'), 'v1\n', 'utf8')
    git('add', '-A')
    git('-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'init')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const signal = new AbortController().signal

  it('reports a tracked file that was deleted', async () => {
    await rm(join(root, 'tracked.txt'))
    await expect(scanDeletedPaths(runNativeCommand, root, signal))
      .resolves.toEqual({ kind: 'ok', paths: [join(root, 'tracked.txt')] })
  })

  it('reports a file removed by a script rather than by rm', async () => {
    // The point of asking git instead of parsing the command: the deletion is
    // seen whatever removed the file.
    execFileSync('python3', ['-c', 'import os; os.remove("tracked.txt")'], { cwd: root, stdio: 'pipe' })
    await expect(scanDeletedPaths(runNativeCommand, root, signal))
      .resolves.toEqual({ kind: 'ok', paths: [join(root, 'tracked.txt')] })
  })

  it('reports nothing when the file is present', async () => {
    await expect(scanDeletedPaths(runNativeCommand, root, signal)).resolves.toEqual({ kind: 'ok', paths: [] })
  })

  it('reports absolute paths even when the workspace is a repository subdirectory', async () => {
    // git reports paths relative to the REPOSITORY root even when `-C` names a
    // subdirectory, so resolving them against the workspace would double the
    // prefix: `proj/a.txt` under workspace `.../proj` would become
    // `.../proj/proj/a.txt` and never match the file that was deleted.
    const nested = join(root, 'proj')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'a.txt'), 'x\n', 'utf8')
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', root, '-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'nested'], { stdio: 'pipe' })
    await rm(join(nested, 'a.txt'))

    await expect(scanDeletedPaths(runNativeCommand, nested, signal))
      .resolves.toEqual({ kind: 'ok', paths: [join(nested, 'a.txt')] })
  })

  it('leaves out a deletion outside the session workspace', async () => {
    // A session shows its own workspace, so a deletion elsewhere in the same
    // repository is not this list's subject.
    const nested = join(root, 'proj')
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'outside.txt'), 'o\n', 'utf8')
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', root, '-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'two'], { stdio: 'pipe' })
    await rm(join(root, 'tracked.txt'))
    await rm(join(root, 'outside.txt'))

    await expect(scanDeletedPaths(runNativeCommand, nested, signal)).resolves.toEqual({ kind: 'ok', paths: [] })
  })

  it('reports every deleted file rather than collapsing a directory', async () => {
    await writeFile(join(root, 'dir-a.txt'), 'a\n', 'utf8')
    await writeFile(join(root, 'dir-b.txt'), 'b\n', 'utf8')
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', root, '-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'two'], { stdio: 'pipe' })
    await rm(join(root, 'dir-a.txt'))
    await rm(join(root, 'dir-b.txt'))
    const scan = await scanDeletedPaths(runNativeCommand, root, signal)
    expect(scan.kind).toBe('ok')
    expect(scan.kind === 'ok' ? [...scan.paths].sort() : [])
      .toEqual([join(root, 'dir-a.txt'), join(root, 'dir-b.txt')].sort())
  })

  it('reports unavailable for a directory that is not a repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-not-git-'))
    try {
      await expect(scanDeletedPaths(runNativeCommand, plain, signal))
        .resolves.toEqual({ kind: 'unavailable', reason: 'not-a-repository' })
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('reports unavailable for a directory that does not exist', async () => {
    await expect(scanDeletedPaths(runNativeCommand, join(root, 'nope', 'deeper'), signal))
      .resolves.toEqual({ kind: 'unavailable', reason: 'failed' })
  })
})
