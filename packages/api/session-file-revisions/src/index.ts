/**
 * Host owner of the `sessionFileRevisions` Remote namespace: list a session's
 * changed files, read one file's cumulative diff, and revert a session's
 * changes.
 *
 * Every entry point takes a session id and resolves the session's own workspace
 * root, so a revert can only ever write inside the workspace the session was
 * created in. Reading the current content happens at revert time rather than
 * from the captured end state, which is what lets a revert keep changes the
 * session did not make.
 *
 * @module @deepseek-ai/dsh-api-session-file-revisions
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the session store's Context merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-file-revisions'
import { lineCounts, readDeletedContent, revertContent } from '@deepseek-ai/dsh-session-file-revisions'
import type { FileRevision } from '@deepseek-ai/dsh-session-file-revisions/types'
import { canonicalOf, containPath, EscapeError } from './containment.ts'
import type {
  RevisionDiff, RevisionEntry, RevertFileResult, RevertResult, RevertStatus,
  RevisionsDiffRequest, RevisionsListRequest, RevisionsRevertRequest,
} from './types.ts'

export type * from './types.ts'
// The line counts and the deleted-path restore are the capture layer's, so the
// Host surface and any other consumer read one implementation; re-exported
// because this is the package a Client reads the entry vocabulary from.
export { lineCounts, type LineCounts } from '@deepseek-ai/dsh-session-file-revisions'

/**
 * Inclusive byte ceiling of one content side sent to the browser. A file past
 * this size reports `oversized` with no content, and stays revertible.
 */
export const DEFAULT_MAX_DIFF_BYTES = 512 * 1024

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host session-revision business API and Remote namespace owner. */
    sessionRevisionController: SessionRevisionController
  }
}

/**
 * Whether a revert outcome means the session's change is gone from the file.
 *
 * Only a completed revert retires the path's record. A conflict or a missing
 * file still holds this session's change — or leaves its fate undecided — so
 * retiring there would drop the only record of what the session did. An
 * unchanged outcome means no revert actually happened, which leaves the record
 * as the sole description of the file's current state.
 * @param status - one path's revert outcome.
 * @returns true when the path's revision should be dropped.
 */
export function retiresRevision(status: RevertStatus): boolean {
  return status === 'reverted'
}

/** Host service backing the generated `ctx.remote.sessionFileRevisions` namespace. */
export class SessionRevisionController extends TypertRemoteService {
  static inject = ['typert', 'sessionFileRevisions', 'sessions']

  /** @param ctx - Host context carrying the revision service and session store. */
  constructor(ctx: Context) {
    super(ctx, 'sessionRevisionController', { namespace: 'sessionFileRevisions' })
  }

  /**
   * List every file this session and its subagents changed.
   * @param request - the session to read.
   * @returns one entry per path, in first-mutation order.
   */
  @Remote('list')
  list(request: RevisionsListRequest): Promise<{ entries: readonly RevisionEntry[] }> {
    return Promise.resolve({
      entries: this.revisions(request.sessionId).map((revision): RevisionEntry => {
        const oversized = this.isOversized(revision)
        const counts = lineCounts(revision)
        return {
          path: revision.path,
          operation: revision.operation,
          origin: revision.origin,
          ...counts,
          oversized,
          // The session's own seq, so a row the changed-files log cannot place
          // (a path only a shell command named) still lands in first-seen order.
          firstSeq: revision.firstOrder.seq,
          lastSeq: revision.lastOrder.seq,
        }
      }),
    })
  }

  /**
   * Read one file's cumulative diff for this session.
   * @param request - the session and the path to read.
   * @returns both content sides, or neither when the file is oversized or has no baseline.
   */
  @Remote('diff')
  diff(request: RevisionsDiffRequest): Promise<RevisionDiff> {
    const revision = this.revisionOf(request.sessionId, request.path)
    // An uncaptured baseline has nothing to compare against; sending the end
    // state beside a null baseline would draw the whole file as newly added,
    // which is a claim the capture cannot support.
    if (revision.origin === 'unknown') {
      return Promise.resolve({
        path: revision.path,
        origin: revision.origin,
        baseline: null,
        endState: '',
        withheld: 'baseline-missing',
      })
    }
    if (this.isOversized(revision)) {
      return Promise.resolve({
        path: revision.path,
        origin: revision.origin,
        baseline: null,
        endState: '',
        withheld: 'oversized',
      })
    }
    return Promise.resolve({
      path: revision.path,
      origin: revision.origin,
      baseline: revision.baseline,
      endState: revision.endState,
      withheld: null,
    })
  }

  /**
   * Revert one file, or every file this session changed.
   *
   * Each path is reverted on its own: one conflict does not stop the rest, and
   * the results name what happened per path. A path whose reverse patch no
   * longer matches is reported as a conflict and left untouched.
   * @param request - the session and the optional single path.
   * @returns one result per attempted path.
   */
  @Remote('revert')
  async revert(request: RevisionsRevertRequest): Promise<RevertResult> {
    const root = this.workspaceRootOf(request.sessionId)
    const targets = request.path === undefined
      ? this.revisions(request.sessionId)
      : [this.revisionOf(request.sessionId, request.path)]
    const results: RevertFileResult[] = []
    for (const revision of targets) {
      const result = await this.revertOne(root, revision)
      // Retiring here is what stops the surface from offering a file that is
      // already back to its baseline — and, once the record is durable, from
      // offering it again after every restart.
      if (retiresRevision(result.status)) {
        await this.ctx.sessionFileRevisions.dropPath(request.sessionId, result.path)
      }
      results.push(result)
    }
    return { results }
  }

  /**
   * Revert one path, reporting what happened without throwing for a conflict.
   * @param root - the session's workspace root.
   * @param revision - the path's captured revision.
   * @returns the outcome for this path.
   */
  private async revertOne(root: string, revision: FileRevision): Promise<RevertFileResult> {
    let contained: string
    try {
      contained = await containPath(root, revision.path)
    } catch (error: unknown) {
      if (error instanceof EscapeError) {
        return { path: revision.path, status: 'missing', reason: error.message }
      }
      throw error
    }
    const current = await this.readOrNull(contained)
    // The path was removed by a shell command, so this record carries no content
    // of its own. The workspace's git objects hold the version to restore, and
    // which object that is depends on how the file stood when it was deleted —
    // hence two sources rather than one.
    if (revision.origin === 'deleted') {
      if (current !== null) return { path: revision.path, status: 'unchanged' }
      return this.restoreDeleted(root, contained, revision)
    }
    // `unknown` means this session overwrote a file whose prior content was
    // never captured. Its baseline cannot be reconstructed, so refusing is the
    // only honest outcome: the session may well have created the file, but
    // deleting it on that guess would destroy content the session never made.
    if (revision.origin === 'unknown') {
      return {
        path: revision.path,
        status: 'conflict',
        reason: 'this session overwrote a file whose prior content was not captured',
      }
    }
    // The session created this file: reverting means removing it again, but
    // only while it still holds what the session wrote — content someone else
    // put there afterwards is not this session's to delete.
    if (revision.origin === 'absent') {
      if (current === null) return { path: revision.path, status: 'unchanged' }
      if (current !== revision.endState) {
        return { path: revision.path, status: 'conflict', reason: 'file changed after this session created it' }
      }
      await rm(contained)
      return { path: revision.path, status: 'reverted' }
    }
    if (current === null) return { path: revision.path, status: 'missing' }
    const result = revertContent(revision.baseline as string, revision.endState, current)
    if (result.applied === 'none') {
      return { path: revision.path, status: 'conflict', reason: 'this session\'s changes were overwritten' }
    }
    if (result.content === current) return { path: revision.path, status: 'unchanged' }
    await this.writeAtomic(contained, result.content)
    return result.applied === 'partial'
      ? { path: revision.path, status: 'conflict', reason: `${String(result.skipped)} hunk(s) could not be reverted` }
      : { path: revision.path, status: 'reverted' }
  }

  /**
   * Restore one deleted path from the workspace's git objects.
   *
   * Which source holds the content depends on whether the file was ever
   * committed, and the two situations where neither does are the reader's to
   * act on: a path git has never heard of has no content anywhere, while a
   * workspace outside version control has no git answers at all. Both are
   * reported per path so the surface can say which one the reader is in.
   * @param root - the session's workspace root, where git runs.
   * @param contained - the already-contained absolute path to restore.
   * @param revision - the deleted path's record.
   * @returns the outcome for this path.
   */
  private async restoreDeleted(
    root: string,
    contained: string,
    revision: FileRevision,
  ): Promise<RevertFileResult> {
    // The root is canonicalized the same tolerant way `containPath` canonicalized
    // the file: on a DELETED path a plain `realpath` fails, so mixing a resolved
    // root with an unresolved file path would subtract two unrelated prefixes and
    // the restore would look up a path git never had.
    const canonicalRoot = await canonicalOf(root)
    const outcome = await readDeletedContent(
      runNativeCommand,
      canonicalRoot,
      contained,
      this.revertSignal(),
    )
    if (outcome.kind === 'restored') {
      await this.writeAtomic(contained, outcome.content)
      return { path: revision.path, status: 'reverted' }
    }
    if (outcome.kind === 'blocked') {
      return { path: revision.path, status: 'missing', blocked: outcome.reason }
    }
    return { path: revision.path, status: 'missing' }
  }

  /**
   * The signal one git restore observes.
   *
   * A restore is short and owned by the request that asked for it rather than by
   * a tool call, so there is no caller signal to reuse; the fresh controller
   * keeps the boundary honest without inventing cancellation this path cannot
   * honor.
   * @returns an unaborted signal.
   */
  private revertSignal(): AbortSignal {
    return new AbortController().signal
  }

  /**
   * Read a file's current text, or null when it is not there.
   * @param path - absolute path to read.
   * @returns the text, or null when the file is absent.
   */
  private async readOrNull(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * Write text through a same-directory temporary file and rename, so a crash
   * mid-write cannot leave a truncated file.
   * @param path - absolute path to write.
   * @param content - the text to write.
   */
  private async writeAtomic(path: string, content: string): Promise<void> {
    const temporary = join(dirname(path), `.${randomBytes(8).toString('hex')}.tmp`)
    await writeFile(temporary, content, 'utf8')
    try {
      await rename(temporary, path)
    } catch (error: unknown) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  /**
   * Whether a revision's content is past the display ceiling.
   * @param revision - the revision to measure.
   * @returns true when neither side should be sent to the browser.
   */
  private isOversized(revision: FileRevision): boolean {
    const baselineBytes = revision.baseline === null ? 0 : Buffer.byteLength(revision.baseline, 'utf8')
    return baselineBytes > DEFAULT_MAX_DIFF_BYTES
      || Buffer.byteLength(revision.endState, 'utf8') > DEFAULT_MAX_DIFF_BYTES
  }

  /**
   * Every revision recorded for a session.
   * @param sessionId - the session to read.
   * @returns its revisions.
   */
  private revisions(sessionId: SessionId): readonly FileRevision[] {
    return this.ctx.sessionFileRevisions.list(sessionId)
  }

  /**
   * One path's revision.
   * @param sessionId - the session to read.
   * @param path - the absolute path to find.
   * @returns the revision.
   * @throws {RemoteError} `session-revisions/unknown-path` when the path is not recorded.
   */
  private revisionOf(sessionId: SessionId, path: string): FileRevision {
    const revision = this.revisions(sessionId).find(entry => entry.path === path)
    if (revision === undefined) {
      throw new RemoteError(
        'session-revisions/unknown-path',
        `this session recorded no change for path: ${path}`,
        { path },
      )
    }
    return revision
  }

  /**
   * The workspace root a session was created in.
   * @param sessionId - the session to resolve.
   * @returns the absolute workspace root.
   * @throws {RemoteError} `session-revisions/no-workspace` when it has none.
   */
  private workspaceRootOf(sessionId: SessionId): string {
    const cwd = this.ctx.sessions.get(sessionId)?.header.cwd
    if (cwd === undefined) {
      throw new RemoteError(
        'session-revisions/no-workspace',
        `session has no workspace root: ${String(sessionId)}`,
        { sessionId: String(sessionId) },
      )
    }
    return cwd
  }
}

export default SessionRevisionController
