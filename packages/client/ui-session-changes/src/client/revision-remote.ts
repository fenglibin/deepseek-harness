/**
 * The session-revisions Remote vocabulary the dock drives: the verbs, the failure
 * that carries the Host's code across the wire, and the sentence one failure
 * earns.
 *
 * @module @deepseek-ai/dsh-client-ui-session-changes/revision-remote
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type {
  RevisionDiff, RevisionEntry, RevertFileResult,
} from '@deepseek-ai/dsh-api-session-file-revisions/types'

/**
 * One failure of the session-revisions Remote, carrying the Host's stable
 * failure code alongside its diagnostic message.
 *
 * The code is what earns the reader a sentence about their own situation —
 * "this session never recorded that file" is a different fact from "the Host
 * refused". The message stays untouched for codes this surface does not know,
 * so an unmapped failure still shows the Host's own words instead of a generic
 * apology.
 */
export class RevisionError extends Error {
  /**
   * @param code - the Host's stable failure code.
   * @param message - the Host's diagnostic, kept verbatim for unmapped codes.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RevisionError'
  }
}

/** The Host verbs the dock drives through the session-revisions Remote. */
export interface RevisionRemote {
  /**
   * Every path this session recorded a revision for.
   *
   * This is the authority the rows are filtered by: the changed-file list and
   * the revision record have different lifetimes, so a listed path is not
   * always a viewable one. The answer is a summary — no file content crosses.
   * @param sessionId - the session to read.
   * @returns one entry per recorded path.
   */
  list: (sessionId: string) => Promise<readonly RevisionEntry[]>
  /** Read one file's cumulative diff for the session. */
  diff: (sessionId: string, path: string) => Promise<RevisionDiff>
  /**
   * Revert one path, or every path the Host recorded for the session.
   *
   * One verb for both because the Host already resolves the single-path case by
   * narrowing its own target set: a second verb would only duplicate that fork,
   * and the two would have to agree forever on what "all" means.
   * @param sessionId - the session whose changes are reverted.
   * @param path - the single path to revert; omitted reverts every recorded path.
   * @returns one result per attempted path.
   */
  revert: (sessionId: string, path?: string) => Promise<readonly RevertFileResult[]>
}

/**
 * The sentence one failed revision call earns, chosen by the Host's failure code.
 *
 * Two codes name a situation the reader can act on, so they get their own
 * sentence; every other code keeps the Host's diagnostic under the verb's own
 * label, because an unmapped failure is more useful read than paraphrased.
 * @param cause - the rejection the Remote verb produced.
 * @param t - the owning surface's locale seat.
 * @param fallbackKey - the verb's own failure label, used for unmapped codes.
 * @returns the reader-facing failure text.
 */
export function revisionFailureText(
  cause: unknown,
  t: PropsLocale<'session-changes'>['t'],
  fallbackKey: 'diffFailed' | 'revertFailed' | 'diff.viewerFailed',
): string {
  if (cause instanceof RevisionError) {
    if (cause.code === 'session-revisions/unknown-path') return t('diff.noRecord')
    if (cause.code === 'session-revisions/no-workspace') return t('diff.noWorkspace')
  }
  return t(fallbackKey, { message: cause instanceof Error ? cause.message : String(cause) })
}

/**
 * The sentence one unrestorable deleted path earns.
 *
 * The Host reports why a restore could not proceed as a stable cause rather
 * than as prose, because the two situations differ in what the reader should
 * expect: content git never held is gone for good, while a workspace outside
 * version control simply cannot answer for deletions at all. A result without a
 * cause is not this function's subject — the batch summary already accounts for
 * those outcomes — so it returns null rather than inventing wording.
 * @param result - one path's revert outcome.
 * @param t - the owning surface's locale seat.
 * @returns the reader-facing text, or null when this outcome needs no sentence of its own.
 */
export function revertBlockedText(
  result: RevertFileResult,
  t: PropsLocale<'session-changes'>['t'],
): string | null {
  if (result.blocked === 'not-in-git') return t('revertNotInGit', { name: workspaceTitleOf(result.path) })
  if (result.blocked === 'not-a-repository') return t('revertNoRepository')
  return null
}
