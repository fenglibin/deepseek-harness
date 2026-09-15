/**
 * Observation settling for guarded mutations, plus model-facing remediation for
 * the failures that remain. A mutation the policy refuses for want of an
 * observation is never the model's problem to fix: the tool reads the target
 * itself — that read IS the observation the policy wants — and retries, all
 * before the call returns, so nothing transient reaches the session log or the
 * page. A genuinely stale or unmatchable mutation still fails, and its message
 * carries the current content the retry must rebase onto.
 * @module @deepseek-ai/dsh-tool-fs/src/error
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { formatReadOutput } from './read-render.ts'
import { readFileWindow } from './read.ts'
import type { ReadToolCaps } from './read.ts'

/** The remedy appended to each recoverable failure code's message. */
const REMEDIES: Partial<Record<FsErrorCode, string>> = {
  FS_STALE_VERSION: 're-read the file, then retry',
  FS_NOT_OBSERVED: 'read the file, then retry',
}

/**
 * Append the correct recovery instruction to a guarded-mutation failure's
 * message. `FS_STALE_VERSION` (the file changed since this session's last
 * observation, including a missing target) recovers only by re-reading;
 * `FS_NOT_OBSERVED` (no prior read by this session) by reading. The `FsError`
 * code is preserved so retry/permission/UI layers keep routing on it, and the
 * original error chains as `cause`. Anything else passes through untouched.
 * @param error - the caught value from a write/edit execution.
 * @returns a remediated `FsError` for the two guarded-mutation codes, else the original value.
 */
export function remediateFsError(error: unknown): unknown {
  if (!(error instanceof FsError)) return error
  const remedy = REMEDIES[error.code]
  if (!remedy) return error
  return new FsError(`${error.message} — ${remedy}`, error.code, { cause: error })
}

/**
 * Whether a failure is the policy's missing-observation gate — the one refusal
 * the tool can settle itself rather than report.
 * @param error - the caught value from an intent dispatch or a guarded mutation.
 * @returns true only for `FS_NOT_OBSERVED`.
 */
function isUnobservedRefusal(error: unknown): boolean {
  return error instanceof FsError && error.code === 'FS_NOT_OBSERVED'
}

/**
 * The outcome of recording one authoritative observation of a mutation target.
 * `unusable` means this call learned nothing the policy can act on, so
 * re-dispatching the intent slot would return the very refusal already seen.
 */
type TargetObservation = 'present' | 'absent' | 'unusable'

/**
 * Record the observation the policy derives its version basis from. A regular
 * file is read as a bounded, model-facing envelope and recorded present; an
 * absent target is recorded absent — the authoritative negative observation
 * that lets the policy answer `FS_NOT_FOUND` for an edit and a guarded create
 * for a write, rather than telling the model to read a file that is not there.
 * A target that is neither a regular file nor absent (a directory, a special
 * file) records nothing, so the caller keeps the failure it already has.
 * @param ctx - the plugin context providing the filesystem service and observation events.
 * @param exec - the current tool execution, including cancellation.
 * @param target - the resolved mutation target.
 * @param caps - the deployment's resolved read caps, which bound the window.
 * @returns which observation was recorded, and therefore what the policy can now answer.
 */
async function observeTarget(
  ctx: Context,
  exec: ToolExecution,
  target: FsTarget,
  caps: ReadToolCaps,
): Promise<TargetObservation> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    return 'absent'
  }
  if (info.type !== 'file') return 'unusable'
  await readFileWindow(ctx, exec, target, info, caps, { offset: 1, limit: caps.limit })
  return 'present'
}

/**
 * Run one guarded mutation, settling a missing-observation refusal in place.
 *
 * The policy refuses a mutation whose target this session never read. That
 * refusal is never the model's to fix: the tool reads the target, and the read
 * itself records the observation the policy demands. Re-dispatching the intent
 * slot then yields the version basis the mutation needs, so the identical
 * mutation succeeds — inside the same call, before any result reaches the
 * session. Nothing about the refusal is logged, streamed, or rendered: the
 * model sees one successful tool result, never a transient error row.
 *
 * A target that cannot be read (absent, a directory, binary, or an aborted
 * call) keeps the original refusal, which the caller remediates. A mutation
 * that fails for a genuine reason — a stale version, a literal match that
 * never existed — passes through untouched.
 *
 * The read happens only when it is needed: a session that already observed the
 * target pays neither the read nor a probe stat.
 * @param ctx - the plugin context providing the filesystem service and observation events.
 * @param exec - the current tool execution, including cancellation.
 * @param target - the resolved mutation target.
 * @param caps - the deployment's resolved read caps, which bound the recovery read.
 * @param dispatchIntent - dispatches the `fs/*-intent` slot, re-run after the read so the policy can supply the fresh basis.
 * @param mutate - performs the guarded provider mutation with the dispatched intent.
 * @returns the mutation's outcome.
 */
export async function mutateWithObservedBasis<TIntent, TOutcome>(
  ctx: Context,
  exec: ToolExecution,
  target: FsTarget,
  caps: ReadToolCaps,
  dispatchIntent: () => Promise<TIntent | undefined>,
  mutate: (intent: TIntent | undefined) => Promise<TOutcome>,
): Promise<TOutcome> {
  try {
    return await mutate(await dispatchIntent())
  } catch (error: unknown) {
    if (!isUnobservedRefusal(error)) throw error
    // The policy refused for want of an observation. Recording one — the
    // target's content, or authoritatively its absence — is what the refusal
    // asks for; re-dispatching the slot then yields the policy's real answer,
    // which differs by tool and by fact. An observed target supplies the version
    // basis the mutation CASes against; an absent target is `FS_NOT_FOUND` for
    // an edit and a guarded create for a write. Either way the policy decides,
    // so this recovery never invents a verdict of its own.
    if (await observeTarget(ctx, exec, target, caps) === 'unusable') throw error
    return await mutate(await dispatchIntent())
  }
}

/**
 * Turn a guarded-mutation failure that survived in-call settling into the
 * failure the model acts on.
 *
 * A remaining `FS_STALE_VERSION` means the file changed underneath a mutation
 * that already held an observation — the model cannot rebase without the new
 * content. This re-reads the target and appends that content to the failure
 * message, sparing the model a discovery round trip before its retry. A target
 * that cannot be re-read (absent, unreadable, a directory, or an aborted call)
 * keeps its plain remedy: the mutation's own failure is the actionable result,
 * and a recovery attempt must never replace it.
 * @param ctx - the plugin context providing the filesystem service and observation events.
 * @param exec - the current tool execution, including cancellation.
 * @param error - the sandbox-mapped failure from the mutation.
 * @param target - the resolved mutation target.
 * @param caps - the deployment's resolved read caps, which bound the recovery read.
 * @returns the recovered failure when the re-read succeeded, else the remediated original.
 */
export async function recoverMutationFailure(
  ctx: Context,
  exec: ToolExecution,
  error: unknown,
  target: FsTarget,
  caps: ReadToolCaps,
): Promise<unknown> {
  if (!(error instanceof FsError) || REMEDIES[error.code] === undefined) return error
  let content: string | undefined
  try {
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined) {
      // The target is gone. Recording that absence is the authoritative negative
      // observation the policy needs to let the next guarded write recreate it,
      // so a deletion discovered while recovering does not strand the retry.
      ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    } else if (info.type === 'file') {
      const window = await readFileWindow(ctx, exec, target, info, caps, { offset: 1, limit: caps.limit })
      content = formatReadOutput(target.displayPath, {
        offset: 1,
        lines: window.lines,
        totalLines: window.totalLines,
        ...window.truncatedByBytes ? { truncatedByBytes: true as const } : {},
      })
    }
  } catch {
    // A recovery re-read is best-effort: whatever it threw (an unreadable or
    // concurrently deleted target, a binary file, an abort) must not replace
    // the mutation's own failure, which is what the model has to act on.
    content = undefined
  }
  if (content === undefined) return remediateFsError(error)
  return new FsError(
    `${error.message} — its current content follows; retry now.\n${content}`,
    error.code,
    { cause: error },
  )
}
