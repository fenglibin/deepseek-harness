/**
 * Unit tests for guarded-mutation observation settling and model-facing error
 * recovery: the in-call read that settles a missing-observation refusal before
 * the mutation retries, and the remedy or content appended to the failures that
 * still reach the model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { mutateWithObservedBasis, recoverMutationFailure, remediateFsError } from '../src/error.ts'
import type { ReadToolCaps } from '../src/read.ts'

const caps: ReadToolCaps = { limit: 2000, maxLineLength: 2000, maxBytes: 50 * 1024, streamMinSize: 10 * 1024 * 1024 }
const signal = new AbortController().signal

describe('remediateFsError', () => {
  it('appends the re-read remedy to FS_STALE_VERSION, preserving the code and chaining the cause', () => {
    const original = new FsError('cannot edit "x": file changed since it was read', 'FS_STALE_VERSION')
    const remedied = remediateFsError(original) as FsError
    expect(remedied).toBeInstanceOf(FsError)
    expect(remedied.message).toBe('cannot edit "x": file changed since it was read — re-read the file, then retry')
    expect(remedied.code).toBe('FS_STALE_VERSION')
    expect(remedied.cause).toBe(original)
  })

  it('appends the read remedy to FS_NOT_OBSERVED', () => {
    const remedied = remediateFsError(new FsError('edit requires reading "x" first', 'FS_NOT_OBSERVED')) as FsError
    expect(remedied.message).toBe('edit requires reading "x" first — read the file, then retry')
    expect(remedied.code).toBe('FS_NOT_OBSERVED')
  })

  it('leaves other FsError codes untouched', () => {
    const original = new FsError('no match anywhere', 'FS_EDIT_NOT_FOUND')
    expect(remediateFsError(original)).toBe(original)
  })

  it('leaves non-FsError values untouched', () => {
    const original = new Error('boom')
    expect(remediateFsError(original)).toBe(original)
  })
})

describe('recoverMutationFailure', () => {
  let dir: string
  let ctx: Context
  let fiber: Awaited<ReturnType<Context['plugin']>>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-recover-'))
    ctx = new Context()
    fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  })

  afterEach(async () => {
    await fiber?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  /** An execution stand-in: the recovery path reads only `signal` and emits with the actor. */
  const exec = { signal } as unknown as ToolExecution

  /** Resolve a path against the real backend, as the mutating tools do. */
  const resolve = (path: string) => ctx.fs.resolve(path, { signal })

  it('re-reads a refused target and returns its content in the recovered message', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const target = await resolve('a.txt')
    const refusal = new FsError('edit requires reading "a.txt" first', 'FS_NOT_OBSERVED')

    const recovered = await recoverMutationFailure(ctx, exec, refusal, target, caps) as FsError
    expect(recovered).toBeInstanceOf(FsError)
    // The original refusal stays readable; the content follows it.
    expect(recovered.message).toContain('edit requires reading "a.txt" first')
    expect(recovered.message).toContain('1: hello world')
    // The code survives so retry/permission/UI layers keep routing on it.
    expect(recovered.code).toBe('FS_NOT_OBSERVED')
    expect(recovered.cause).toBe(refusal)
  })

  it('the recovery reread records the observation the policy requires', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const target = await resolve('a.txt')
    const observed: unknown[] = []
    ctx.on('fs/observed', (_target, observation) => { observed.push(observation) })

    await recoverMutationFailure(ctx, exec, new FsError('refused', 'FS_NOT_OBSERVED'), target, caps)
    // A present observation at the read version: exactly what the retry needs.
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ kind: 'present' })
  })

  it('recovers FS_STALE_VERSION the same way, showing what the file now holds', async () => {
    await writeFile(join(dir, 'a.txt'), 'changed-externally')
    const target = await resolve('a.txt')
    const stale = new FsError('cannot write "a.txt": file changed since it was read', 'FS_STALE_VERSION')

    const recovered = await recoverMutationFailure(ctx, exec, stale, target, caps) as FsError
    expect(recovered.message).toContain('file changed since it was read')
    expect(recovered.message).toContain('1: changed-externally')
    expect(recovered.code).toBe('FS_STALE_VERSION')
  })

  it('bounds the returned content with the deployment read caps', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    const target = await resolve('a.txt')
    const recovered = await recoverMutationFailure(
      ctx, exec, new FsError('refused', 'FS_NOT_OBSERVED'), target, { ...caps, limit: 1 },
    ) as FsError
    expect(recovered.message).toContain('1: one')
    expect(recovered.message).not.toContain('2: two')
  })

  it('falls back to the plain remedy when the target is gone', async () => {
    const target = await resolve('missing.txt')
    const refusal = new FsError('cannot write "missing.txt": file changed since it was read', 'FS_STALE_VERSION')

    const recovered = await recoverMutationFailure(ctx, exec, refusal, target, caps) as FsError
    expect(recovered.message).toBe('cannot write "missing.txt": file changed since it was read — re-read the file, then retry')
    expect(recovered.code).toBe('FS_STALE_VERSION')
  })

  it('falls back to the plain remedy when the target is a directory', async () => {
    const target = await resolve('.')
    const refusal = new FsError('cannot edit "." first', 'FS_NOT_OBSERVED')
    const recovered = await recoverMutationFailure(ctx, exec, refusal, target, caps) as FsError
    expect(recovered.message).toContain('read the file, then retry')
  })

  it('leaves a non-recoverable failure untouched, without reading anything', async () => {
    const target = await resolve('a.txt')
    const original = new FsError('no match for old_string', 'FS_EDIT_NOT_FOUND')
    expect(await recoverMutationFailure(ctx, exec, original, target, caps)).toBe(original)
    expect(await recoverMutationFailure(ctx, exec, new Error('boom'), target, caps)).toBeInstanceOf(Error)
  })
})

describe('mutateWithObservedBasis', () => {
  let dir: string
  let ctx: Context
  let fiber: Awaited<ReturnType<Context['plugin']>>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-settle-'))
    ctx = new Context()
    fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  })

  afterEach(async () => {
    await fiber?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const exec = { signal } as unknown as ToolExecution
  const resolve = (path: string) => ctx.fs.resolve(path, { signal })

  /**
   * Observations the gate can see, keyed as the policy keys them: a present
   * observation supplies a version basis, an absent one (`null`) supplies none.
   * Populated by whatever the tool under test publishes through `fs/observed`.
   */
  const observations = new Map<string, string | null>()
  let target: Awaited<ReturnType<typeof resolve>>

  /**
   * A policy stand-in mirroring `fs/edit-intent`: it refuses a target with no
   * recorded observation, and otherwise returns the basis that record carries.
   * @returns the dispatch thunk plus a count of how many times it ran.
   */
  function gate(): { dispatch: (t: typeof target) => Promise<{ version: ReturnType<typeof FsVersion> } | undefined>; dispatches: number } {
    const state = {
      dispatches: 0,
      async dispatch(t: typeof target): Promise<{ version: ReturnType<typeof FsVersion> } | undefined> {
        state.dispatches += 1
        const observed = observations.get(t.targetKey)
        if (observed === undefined) throw new FsError(`edit requires reading "${t.displayPath}" first`, 'FS_NOT_OBSERVED')
        return observed === null ? undefined : { version: FsVersion(observed) }
      },
    }
    return state
  }

  beforeEach(async () => {
    observations.clear()
    ctx.on('fs/observed', (observedTarget, observation) => {
      observations.set(observedTarget.targetKey, observation.kind === 'present' ? 'v-observed' : null)
    })
    target = await resolve('a.txt')
  })

  /** Run the settling helper against the gate, dispatching the gate's own thunk. */
  const runWithGate = (
    t: typeof target,
    g: ReturnType<typeof gate>,
    mutate: (intent: { version: ReturnType<typeof FsVersion> } | undefined) => Promise<unknown>,
  ) => mutateWithObservedBasis(ctx, exec, t, caps, () => g.dispatch(t), mutate as never)

  it('settles a missing-observation refusal by reading, then re-dispatches and mutates', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const policy = gate()
    const mutate = vi.fn(async (intent: { version: ReturnType<typeof FsVersion> } | undefined) => intent)

    const outcome = await runWithGate(target, policy, mutate)
    // First dispatch refuses; the read records the observation; the second
    // dispatch supplies the basis, and only then does the mutation run.
    expect(policy.dispatches).toBe(2)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ version: 'v-observed' })
  })

  it('does not read or re-dispatch when the mutation succeeds on the first attempt', async () => {
    const policy = gate()
    observations.set(target.targetKey, 'v-prior')
    const statSpy = vi.spyOn(ctx.fs, 'stat')
    const mutate = vi.fn(async () => 'ok')

    expect(await runWithGate(target, policy, mutate)).toBe('ok')
    expect(policy.dispatches).toBe(1)
    expect(statSpy).not.toHaveBeenCalled()
    statSpy.mockRestore()
  })

  it('settles a missing target by recording absence, so the retry gets the policy\'s own answer', async () => {
    const policy = gate()
    // The first dispatch refuses (the gate throws before `mutate` ever runs) and
    // the target does not exist, so the recovery read records absence; the
    // re-dispatch then returns the policy's answer for an absent target
    // (undefined = unconditional) and the mutation runs against it.
    const mutate = vi.fn(async (intent: unknown) => intent)

    await runWithGate(target, policy, mutate)
    expect(policy.dispatches).toBe(2)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith(undefined)
    expect(observations.get(target.targetKey)).toBeNull()
  })

  it('passes a non-observation failure straight through without reading', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    const statSpy = vi.spyOn(ctx.fs, 'stat')
    const failure = new FsError('no match for old_string', 'FS_EDIT_NOT_FOUND')

    await expect(mutateWithObservedBasis(
      ctx, exec, target, caps, async () => undefined, async () => { throw failure },
    )).rejects.toBe(failure)
    expect(statSpy).not.toHaveBeenCalled()
    statSpy.mockRestore()
  })

  it('keeps the original refusal when the target is not an observable regular file', async () => {
    const dirTarget = await resolve('.')
    const refusal = new FsError(`edit requires reading "${dirTarget.displayPath}" first`, 'FS_NOT_OBSERVED')

    await expect(mutateWithObservedBasis(
      ctx, exec, dirTarget, caps, async () => { throw refusal }, async () => 'unreachable',
    )).rejects.toBe(refusal)
  })
})
