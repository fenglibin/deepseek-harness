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
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the session store's Context merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-file-revisions'
import { revertContent } from '@deepseek-ai/dsh-session-file-revisions'
import type { FileRevision } from '@deepseek-ai/dsh-session-file-revisions/types'
import { containPath, EscapeError } from './containment.ts'
import type {
  RevisionDiff, RevisionEntry, RevertFileResult, RevertResult,
  RevisionsDiffRequest, RevisionsListRequest, RevisionsRevertRequest,
} from './types.ts'

export type * from './types.ts'

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
 * Count the added and removed lines between two texts, split on LF.
 * @param baseline - content before, or null when the file did not exist.
 * @param endState - content after.
 * @returns the line counts of each side.
 */
function lineCounts(baseline: string | null, endState: string): { added: number; removed: number } {
  const removed = baseline === null ? 0 : baseline.split('\n').length - (baseline.endsWith('\n') ? 1 : 0)
  const added = endState.split('\n').length - (endState.endsWith('\n') ? 1 : 0)
  return { added, removed }
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
    return this.guard(async () => ({
      entries: this.revisions(request.sessionId).map((revision): RevisionEntry => {
        const oversized = this.isOversized(revision)
        const counts = lineCounts(revision.baseline, revision.endState)
        return {
          path: revision.path,
          operation: revision.operation,
          ...counts,
          oversized,
        }
      }),
    }))
  }

  /**
   * Read one file's cumulative diff for this session.
   * @param request - the session and the path to read.
   * @returns both content sides, or neither when the file is oversized.
   */
  @Remote('diff')
  diff(request: RevisionsDiffRequest): Promise<RevisionDiff> {
    return this.guard(async () => {
      const revision = this.revisionOf(request.sessionId, request.path)
      return this.isOversized(revision)
        ? { path: revision.path, baseline: null, endState: '', oversized: true }
        : {
          path: revision.path,
          baseline: revision.baseline,
          endState: revision.endState,
          oversized: false,
        }
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
      results.push(await this.revertOne(root, revision))
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
    // The session created this file: reverting means removing it again, but
    // only while it still holds what the session wrote — content someone else
    // put there afterwards is not this session's to delete.
    if (revision.baseline === null) {
      if (current === null) return { path: revision.path, status: 'unchanged' }
      if (current !== revision.endState) {
        return { path: revision.path, status: 'conflict', reason: 'file changed after this session created it' }
      }
      await rm(contained)
      return { path: revision.path, status: 'reverted' }
    }
    if (current === null) return { path: revision.path, status: 'missing' }
    const result = revertContent(revision.baseline, revision.endState, current)
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

  /**
   * Run one operation that may name a path outside the workspace, translating
   * the containment refusal onto the wire.
   * @param operation - the operation to run.
   * @returns the operation's value.
   */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      if (error instanceof EscapeError) throw new RemoteError(
        'session-revisions/outside-workspace',
        error.message,
        { path: error.path },
      )
      throw error
    }
  }
}

export default SessionRevisionController
