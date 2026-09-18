/**
 * Behavior specs for restoring a deleted path's content from git.
 *
 * These run against a REAL repository in a temp directory. The behavior worth
 * pinning is which git object holds the content for each way a file can stand
 * when it is deleted, and a fake git would only assert my assumption about that
 * rather than git's actual answer.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { readDeletedContent } from '../src/git-restore.ts'

const signal = new AbortController().signal

let root: string

/** Run git in the temp repository, failing the test on a non-zero exit. */
function git(...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-restore-'))
  git('init', '-q', '.')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readDeletedContent', () => {
  it('returns the committed content of a tracked file that was deleted', async () => {
    await writeFile(join(root, 'a.txt'), 'committed\n', 'utf8')
    git('add', '-A')
    git('-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'init')
    await rm(join(root, 'a.txt'))

    await expect(readDeletedContent(runNativeCommand, root, join(root, 'a.txt'), signal))
      .resolves.toEqual({ kind: 'restored', content: 'committed\n', source: 'head' })
  })

  it('returns the index content of a staged but uncommitted file', async () => {
    // `git restore --source=HEAD` fails silently for this path because HEAD has
    // no such file; the index is the only place its content lives.
    await writeFile(join(root, 'new.txt'), 'staged only\n', 'utf8')
    git('add', 'new.txt')
    await rm(join(root, 'new.txt'))

    await expect(readDeletedContent(runNativeCommand, root, join(root, 'new.txt'), signal))
      .resolves.toEqual({ kind: 'restored', content: 'staged only\n', source: 'index' })
  })

  it('reports a file git has never tracked', async () => {
    await writeFile(join(root, 'untracked.txt'), 'never added\n', 'utf8')
    await rm(join(root, 'untracked.txt'))

    await expect(readDeletedContent(runNativeCommand, root, join(root, 'untracked.txt'), signal))
      .resolves.toEqual({ kind: 'blocked', reason: 'not-in-git' })
  })

  it('reports a workspace outside version control', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-restore-plain-'))
    try {
      await writeFile(join(plain, 'a.txt'), 'x\n', 'utf8')
      await rm(join(plain, 'a.txt'))
      await expect(readDeletedContent(runNativeCommand, plain, join(plain, 'a.txt'), signal))
        .resolves.toEqual({ kind: 'blocked', reason: 'not-a-repository' })
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('restores a file inside a subdirectory', async () => {
    const nested = join(root, 'src')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'a.txt'), 'nested\n', 'utf8')
    git('add', '-A')
    git('-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'init')
    await rm(join(nested, 'a.txt'))

    await expect(readDeletedContent(runNativeCommand, root, join(nested, 'a.txt'), signal))
      .resolves.toEqual({ kind: 'restored', content: 'nested\n', source: 'head' })
  })

  it('restores a file whose workspace is a repository subdirectory', async () => {
    // `HEAD:<path>` wants a REPOSITORY-relative path, so a workspace that is a
    // subdirectory of its repository needs the prefix added: passing the
    // workspace-relative spelling answers "path exists, but not ..." and the
    // restore fails for every file in such a workspace.
    const nested = join(root, 'proj')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'a.txt'), 'nested\n', 'utf8')
    await writeFile(join(root, 'outside.txt'), 'o\n', 'utf8')
    git('add', '-A')
    git('-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'init')
    await rm(join(nested, 'a.txt'))

    await expect(readDeletedContent(runNativeCommand, nested, join(nested, 'a.txt'), signal))
      .resolves.toEqual({ kind: 'restored', content: 'nested\n', source: 'head' })
  })

  it('restores a staged file whose workspace is a repository subdirectory', async () => {
    const nested = join(root, 'proj')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'new.txt'), 'staged\n', 'utf8')
    git('add', 'proj/new.txt')
    await rm(join(nested, 'new.txt'))

    await expect(readDeletedContent(runNativeCommand, nested, join(nested, 'new.txt'), signal))
      .resolves.toEqual({ kind: 'restored', content: 'staged\n', source: 'index' })
  })

  it('preserves multi-line content and a missing trailing newline', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree', 'utf8')
    git('add', '-A')
    git('-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'init')
    await rm(join(root, 'a.txt'))

    await expect(readDeletedContent(runNativeCommand, root, join(root, 'a.txt'), signal))
      .resolves.toEqual({ kind: 'restored', content: 'one\ntwo\nthree', source: 'head' })
  })
})
