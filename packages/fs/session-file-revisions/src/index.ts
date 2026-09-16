/**
 * Session-file-revisions service: capture every file a session mutated together
 * with the content it had before this session first touched it, so a session's
 * changes can be shown and reverted.
 *
 * Capture rides `tools/post-execute` — the one point where a mutation's own
 * result still carries both content sides — so this plugin adds no behavior to
 * `dsh-tool-fs` and never reads a file itself.
 *
 * @module @deepseek-ai/dsh-session-file-revisions
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { captureMutation } from './capture.ts'
import { SessionRevisionStore } from './registry.ts'
import type { FileRevision } from './types.ts'

export {
  captureMutation, foldMutation, type CapturedMutation,
} from './capture.ts'
export { mergeRevisions, SessionRevisionStore, type ParentLookup } from './registry.ts'
export { revertContent, type RevertResult } from './revert.ts'
export type {
  BaselineOrigin, FileRevision, FileRevisionSummary, RevisionOperation, RevisionSize, RevertOutcome,
} from './types.ts'

/**
 * Inclusive byte ceiling of one content side kept for display. A file past this
 * size still records its baseline and end state, so it stays revertible; only
 * the diff preview is withheld.
 */
export const DEFAULT_DISPLAY_MAX_BYTES = 512 * 1024

/** Structural view of the session a tool execution carries. */
interface RevisionExec {
  readonly agent?: {
    readonly session?: {
      readonly header: { readonly id: SessionId; readonly parentSession?: SessionId }
      readonly seq: number
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-session captured file revisions. */
    sessionFileRevisions: SessionFileRevisions
  }
}

/**
 * Per-session captured file revisions.
 *
 * Reading a session returns its own records merged with its subagents', because
 * a subagent's changes are the delegating session's changes too.
 */
export class SessionFileRevisions extends Service {
  static inject = ['tools', 'sessions']

  /** @param ctx - host context carrying the tool runtime and session store. */
  constructor(ctx: Context) {
    super(ctx, 'sessionFileRevisions')
    this.store = new SessionRevisionStore(
      id => this.ctx.sessions.get(id)?.header.parentSession,
    )
    ctx.on('tools/post-execute', async (
      exec: ToolExecution,
      result: ToolExecutionResult,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      // Delegate first: a downstream listener may replace or block the result,
      // and capture follows whatever it accepted.
      const decision = await next()
      if (result.isError) return decision
      const owner = (exec as RevisionExec).agent?.session
      if (owner === undefined) return decision
      const mutation = captureMutation(exec.name, result.value)
      if (mutation === null) return decision
      this.store.record(owner.header.id, mutation, owner.seq)
      return decision
    })
  }

  private readonly store: SessionRevisionStore

  /**
   * Every file this session or its subagents mutated, in first-mutation order.
   * @param sessionId - the session to read.
   * @returns one revision per path.
   */
  list(sessionId: SessionId): readonly FileRevision[] {
    return this.store.list(sessionId)
  }

  /**
   * Drop one session's records and its subagents' link to it.
   * @param sessionId - the session to forget.
   */
  forget(sessionId: SessionId): void {
    this.store.forget(sessionId)
  }
}

export default SessionFileRevisions
