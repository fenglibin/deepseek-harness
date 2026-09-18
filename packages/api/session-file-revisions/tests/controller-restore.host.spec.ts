/**
 * The Host controller's revert path against the real filesystem.
 *
 * The git-facing helpers have their own specs, and so does the reverse-patch
 * revert. What only this suite can show is the composition: which revision the
 * controller picks for a restore, that the content it retrieved actually lands
 * on disk through the atomic write, and that a restored path retires its record.
 * Those are the parts a helper-level spec cannot reach.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionRevisionController from '../src/index.ts'
import type { FileRevision } from '@deepseek-ai/dsh-session-file-revisions/types'

let root: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-revision-controller-'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await rm(root, { recursive: true, force: true })
})

/**
 * A controller whose two collaborators are the smallest fakes that satisfy it.
 *
 * `sessionFileRevisions` is the record source and `sessions` resolves the
 * workspace root; everything below the controller — the git calls and the file
 * writes — is the real implementation under test.
 * @param revisions - the records this session reports.
 * @param sessionId - the session the controller is asked about.
 * @returns the controller plus the paths it retired.
 */
function controller(revisions: readonly FileRevision[], sessionId = 's1') {
  return controllerIn(root, revisions, sessionId)
}

/**
 * The same controller, rooted at an explicit workspace directory.
 * @param workspace - the session's workspace root.
 * @param revisions - the records this session reports.
 * @param sessionId - the session the controller is asked about.
 * @returns the controller plus the paths it retired.
 */
function controllerIn(workspace: string, revisions: readonly FileRevision[], sessionId = 's1') {
  const ctx = new Context()
  contexts.push(ctx)
  const dropped: string[] = []
  ctx.provide('sessionFileRevisions', {
    list: () => revisions,
    dropPath: async (_id: unknown, path: string) => { dropped.push(path) },
  })
  ctx.provide('sessions', {
    get: () => ({ header: { id: SessionId(sessionId), createdAt: 0, cwd: workspace } }),
  })
  ctx.provide('typert', {})
  const instance = new SessionRevisionController(ctx)
  return { controller: instance, dropped }
}

/** Run git in the temp workspace, failing the test on a non-zero exit. */
function git(...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
}

/** One deleted-path revision, as a capture from a shell deletion produces. */
function deletedRevision(path: string): FileRevision {
  const order = { session: SessionId('s1'), at: 1, seq: 1 }
  return { path, baseline: null, origin: 'deleted', endState: '', operation: 'delete', firstOrder: order, lastOrder: order }
}

describe('the listing the controller reports', () => {
  /** One ordinary written revision, as a write/edit capture produces. */
  function writtenRevision(path: string, baseline: string | null, endState: string): FileRevision {
    const order = { session: SessionId('s1'), at: 1, seq: 1 }
    return {
      path,
      baseline,
      origin: baseline === null ? 'absent' : 'existing',
      endState,
      operation: 'write',
      firstOrder: order,
      lastOrder: order,
    }
  }

  it('reports the real line counts, the origin, and the seq bounds', async () => {
    // The row's `+N -M` and its accept rule both read these fields, and the seq
    // bounds are what let a surface place a record-only path among folded rows.
    const path = join(root, 'a.txt')
    const { controller: instance } = controller([writtenRevision(path, 'a\nb\nc\n', 'a\nB\nc\n')])

    const { entries } = await instance.list({ sessionId: SessionId('s1') })

    expect(entries).toEqual([{
      path,
      operation: 'write',
      origin: 'existing',
      added: 1,
      removed: 1,
      oversized: false,
      firstSeq: 1,
      lastSeq: 1,
    }])
  })

  it('reports a deleted path with no counts and its delete operation', async () => {
    const path = join(root, 'gone.txt')
    const { controller: instance } = controller([deletedRevision(path)])

    const { entries } = await instance.list({ sessionId: SessionId('s1') })

    expect(entries).toEqual([{
      path,
      operation: 'delete',
      origin: 'deleted',
      added: 0,
      removed: 0,
      oversized: false,
      firstSeq: 1,
      lastSeq: 1,
    }])
  })

  it('withholds both content sides for a path past the preview ceiling', async () => {
    // The path stays revertible; only the preview is dropped. Sending half a
    // diff would draw a change the capture cannot support.
    const path = join(root, 'big.txt')
    const huge = 'x'.repeat(600 * 1024)
    const { controller: instance } = controller([writtenRevision(path, huge, `${huge}y`)])

    const diff = await instance.diff({ sessionId: SessionId('s1'), path })

    expect(diff).toEqual({ path, origin: 'existing', baseline: null, endState: '', withheld: 'oversized' })
    const { entries } = await instance.list({ sessionId: SessionId('s1') })
    expect(entries[0]?.oversized).toBe(true)
  })

  it('explains an uncaptured baseline instead of drawing a whole-file addition', async () => {
    const path = join(root, 'binary.bin')
    const order = { session: SessionId('s1'), at: 1, seq: 1 }
    const { controller: instance } = controller([{
      path, baseline: null, origin: 'unknown', endState: 'NEW\n', operation: 'write', firstOrder: order, lastOrder: order,
    }])

    await expect(instance.diff({ sessionId: SessionId('s1'), path }))
      .resolves.toEqual({ path, origin: 'unknown', baseline: null, endState: '', withheld: 'baseline-missing' })
  })

  it('answers a recorded path with both content sides', async () => {
    const path = join(root, 'a.txt')
    const { controller: instance } = controller([writtenRevision(path, 'old\n', 'new\n')])

    await expect(instance.diff({ sessionId: SessionId('s1'), path }))
      .resolves.toEqual({ path, origin: 'existing', baseline: 'old\n', endState: 'new\n', withheld: null })
  })

  it('refuses a path with no record for this session', () => {
    // `diff` throws SYNCHRONOUSLY for an unknown path rather than returning a
    // rejected promise, so the refusal is asserted on the call itself.
    const { controller: instance } = controller([])

    expect(() => instance.diff({ sessionId: SessionId('s1'), path: join(root, 'nope.txt') }))
      .toThrow('this session recorded no change')
  })

  it('refuses when the session has no workspace root', async () => {
    // Nothing can be written without one, so the refusal has to happen before
    // any path is resolved.
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionFileRevisions', { list: () => [], dropPath: async () => {} })
    ctx.provide('sessions', { get: () => ({ header: { id: SessionId('s1'), createdAt: 0 } }) })
    ctx.provide('typert', {})
    const instance = new SessionRevisionController(ctx)

    await expect(instance.revert({ sessionId: SessionId('s1') })).rejects.toThrow(/no workspace root/)
  })

  it('reverts a single path when the request names one', async () => {
    // The single-path branch narrows the Host's own target set, which is what
    // lets the surface offer per-file revert through the same verb as bulk.
    await writeFile(join(root, 'a.txt'), 'old\n', 'utf8')
    await writeFile(join(root, 'b.txt'), 'keep\n', 'utf8')
    const a = join(root, 'a.txt')
    const { controller: instance } = controller([
      writtenRevision(a, 'old\n', 'new\n'),
      writtenRevision(join(root, 'b.txt'), 'keep\n', 'changed\n'),
    ])
    await writeFile(a, 'new\n', 'utf8')

    const result = await instance.revert({ sessionId: SessionId('s1'), path: a })

    expect(result.results).toEqual([{ path: a, status: 'reverted' }])
    await expect(readFile(a, 'utf8')).resolves.toBe('old\n')
    // The path the request did NOT name is untouched.
    await expect(readFile(join(root, 'b.txt'), 'utf8')).resolves.toBe('keep\n')
  })

  it('refuses a single path with no record, leaving the disk alone', async () => {
    const { controller: instance } = controller([])

    await expect(instance.revert({ sessionId: SessionId('s1'), path: join(root, 'nope.txt') }))
      .rejects.toThrow('this session recorded no change')
  })

  it('reports an uncaptured baseline as a conflict rather than deleting the file', async () => {
    // The session may well have created the file, but deleting it on that guess
    // would destroy content the session never made.
    await writeFile(join(root, 'binary.bin'), 'NEW\n', 'utf8')
    const path = join(root, 'binary.bin')
    const order = { session: SessionId('s1'), at: 1, seq: 1 }
    const { controller: instance } = controller([{
      path, baseline: null, origin: 'unknown', endState: 'NEW\n', operation: 'write', firstOrder: order, lastOrder: order,
    }])

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results[0]?.status).toBe('conflict')
    await expect(readFile(path, 'utf8')).resolves.toBe('NEW\n')
  })

  it('removes a file the session created once the request is undone', async () => {
    await writeFile(join(root, 'made.txt'), 'fresh\n', 'utf8')
    const path = join(root, 'made.txt')
    const { controller: instance, dropped } = controller([writtenRevision(path, null, 'fresh\n')])

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results).toEqual([{ path, status: 'reverted' }])
    await expect(readFile(path, 'utf8')).rejects.toThrow()
    expect(dropped).toEqual([path])
  })

  it('leaves a file the session created alone when it changed afterwards', async () => {
    // Content someone else put there is not this session's to delete.
    await writeFile(join(root, 'made.txt'), 'someone else\n', 'utf8')
    const path = join(root, 'made.txt')
    const { controller: instance, dropped } = controller([writtenRevision(path, null, 'fresh\n')])

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results[0]?.status).toBe('conflict')
    await expect(readFile(path, 'utf8')).resolves.toBe('someone else\n')
    expect(dropped).toEqual([])
  })

  it('reverts a written path by reverse-patching it on disk', async () => {
    // The changed-file path (not a deletion) still has to reach the disk through
    // this controller; the reverse-patch arithmetic itself is the capture
    // package's spec.
    await writeFile(join(root, 'a.txt'), 'old\n', 'utf8')
    const path = join(root, 'a.txt')
    const { controller: instance, dropped } = controller([writtenRevision(path, 'old\n', 'new\n')])
    await writeFile(path, 'new\n', 'utf8')

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results).toEqual([{ path, status: 'reverted' }])
    await expect(readFile(path, 'utf8')).resolves.toBe('old\n')
    expect(dropped).toEqual([path])
  })
})

describe('restoring a deleted path through the controller', () => {
  it('writes the committed content back and retires the record', async () => {
    git('init', '-q', '.')
    await writeFile(join(root, 'a.txt'), 'committed\n', 'utf8')
    git('add', '-A')
    git('-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'init')
    await rm(join(root, 'a.txt'))
    const path = join(root, 'a.txt')
    const { controller: instance, dropped } = controller([deletedRevision(path)])

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results).toEqual([{ path, status: 'reverted' }])
    // The content must be ON DISK, not merely reported as restored.
    await expect(readFile(path, 'utf8')).resolves.toBe('committed\n')
    expect(dropped).toEqual([path])
  })

  it('writes the index content back for a staged file that was never committed', async () => {
    git('init', '-q', '.')
    await writeFile(join(root, 'new.txt'), 'staged only\n', 'utf8')
    git('add', 'new.txt')
    await rm(join(root, 'new.txt'))
    const path = join(root, 'new.txt')
    const { controller: instance } = controller([deletedRevision(path)])

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results[0]?.status).toBe('reverted')
    await expect(readFile(path, 'utf8')).resolves.toBe('staged only\n')
  })

  it('reports a file git never tracked and leaves the disk alone', async () => {
    git('init', '-q', '.')
    await writeFile(join(root, 'untracked.txt'), 'never added\n', 'utf8')
    await rm(join(root, 'untracked.txt'))
    const path = join(root, 'untracked.txt')
    const { controller: instance, dropped } = controller([deletedRevision(path)])

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results).toEqual([{ path, status: 'missing', blocked: 'not-in-git' }])
    // Nothing was created, and an unrestored path keeps its record so the reader
    // can see the situation rather than lose the only account of the deletion.
    await expect(readFile(path, 'utf8')).rejects.toThrow()
    expect(dropped).toEqual([])
  })

  it('reports a workspace outside version control', async () => {
    await writeFile(join(root, 'plain.txt'), 'x\n', 'utf8')
    await rm(join(root, 'plain.txt'))
    const path = join(root, 'plain.txt')
    const { controller: instance } = controller([deletedRevision(path)])

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results).toEqual([{ path, status: 'missing', blocked: 'not-a-repository' }])
  })

  it('restores a deleted path when the workspace is a repository subdirectory', async () => {
    // The end-to-end case for a nested workspace: the record holds an absolute
    // path, git wants a repository-relative one, and the two only agree when the
    // workspace IS the repository root. A controller that hands git the
    // workspace-relative spelling restores nothing here.
    git('init', '-q', '.')
    const nested = join(root, 'proj')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'a.txt'), 'nested\n', 'utf8')
    await writeFile(join(root, 'outside.txt'), 'o\n', 'utf8')
    git('add', '-A')
    git('-c', 'user.email=a@b', '-c', 'user.name=c', 'commit', '-qm', 'init')
    await rm(join(nested, 'a.txt'))
    const path = join(nested, 'a.txt')
    const { controller: instance, dropped } = controllerIn(nested, [deletedRevision(path)])

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results).toEqual([{ path, status: 'reverted' }])
    await expect(readFile(path, 'utf8')).resolves.toBe('nested\n')
    expect(dropped).toEqual([path])
  })

  it('leaves an already-present file untouched without retiring its record', async () => {
    // The reader restored it by hand, or another process did. Reporting a revert
    // that did nothing would misstate what happened, so the outcome is
    // `unchanged` and the record stays as the description of the path.
    git('init', '-q', '.')
    await writeFile(join(root, 'a.txt'), 'back again\n', 'utf8')
    const path = join(root, 'a.txt')
    const { controller: instance, dropped } = controller([deletedRevision(path)])

    const result = await instance.revert({ sessionId: SessionId('s1') })

    expect(result.results).toEqual([{ path, status: 'unchanged' }])
    await expect(readFile(path, 'utf8')).resolves.toBe('back again\n')
    expect(dropped).toEqual([])
  })
})
