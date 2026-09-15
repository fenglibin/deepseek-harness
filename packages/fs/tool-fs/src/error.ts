/**
 * Model-facing recovery for guarded-mutation failures. A refusal that only
 * lacks a fresh observation is recoverable inside the same call: the tool
 * re-reads the target, which records the observation the policy demands and
 * hands the model the file's current content, so the retry costs no discovery
 * round trip. Failures with no such recovery keep the provider's
 * machine-oriented message plus their remedy.
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
 * Re-read one mutation target as bounded, model-facing content. The read emits
 * its own `fs/observed`, which is what satisfies the policy on the retry.
 * @param ctx - the plugin context providing the filesystem service and observation events.
 * @param exec - the current tool execution, including cancellation.
 * @param target - the resolved mutation target.
 * @param caps - the deployment's resolved read caps.
 * @returns the read envelope, or undefined when the target is absent or not a regular file.
 */
async function rereadTarget(
  ctx: Context,
  exec: ToolExecution,
  target: FsTarget,
  caps: ReadToolCaps,
): Promise<string | undefined> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined || info.type !== 'file') return undefined
  const window = await readFileWindow(ctx, exec, target, info, caps, { offset: 1, limit: caps.limit })
  return formatReadOutput(target.displayPath, {
    offset: 1,
    lines: window.lines,
    totalLines: window.totalLines,
    ...window.truncatedByBytes ? { truncatedByBytes: true as const } : {},
  })
}

/**
 * Turn one guarded-mutation failure into the failure the model retries from.
 *
 * `FS_NOT_OBSERVED` and `FS_STALE_VERSION` share a single remedy — read the
 * target again — so this recovers both in place: it re-reads the target, which
 * records the observation the policy requires, and appends the file's current
 * content to the failure message. The model then retries with that content
 * already in hand instead of spending a round trip discovering it had to read
 * first.
 *
 * The reread is best-effort by contract. A target that cannot be re-read
 * (absent, unreadable, a directory, or an already-cancelled call) leaves the
 * failure with its plain remedy: the mutation's own failure is the actionable
 * result, and a recovery attempt must never replace it.
 * @param ctx - the plugin context providing the filesystem service and observation events.
 * @param exec - the current tool execution, including cancellation.
 * @param error - the sandbox-mapped failure from the mutation.
 * @param target - the resolved mutation target.
 * @param caps - the deployment's resolved read caps.
 * @returns the recovered failure when the reread succeeded, else the remediated original.
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
    content = await rereadTarget(ctx, exec, target, caps)
  } catch {
    // A recovery reread is best-effort: whatever it threw (an unreadable or
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
