/**
 * Browser-safe vocabulary for the `sessionFileRevisions` Remote namespace.
 * Types only — a Client consumer reads the very declarations the Host answers,
 * including the `RemoteErrorDetailsMap` codes.
 *
 * @module @deepseek-ai/dsh-api-session-file-revisions/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Operation kind of the mutation that first touched a path in the session. */
export type RevisionOperation = 'write' | 'edit'

/**
 * One changed file as the list reports it.
 *
 * `oversized` means the content exceeds the display ceiling: the file still has
 * a recorded baseline and end state and stays revertible, but no diff preview is
 * sent to the browser.
 */
export interface RevisionEntry {
  /** Absolute path of the changed file. */
  readonly path: string
  readonly operation: RevisionOperation
  /** Added and removed line counts of the session's cumulative diff. */
  readonly added: number
  readonly removed: number
  /** True when the content is past the display ceiling and no preview is sent. */
  readonly oversized: boolean
}

/** One file's cumulative diff: what the session did to it. */
export interface RevisionDiff {
  readonly path: string
  /** Content before this session's first mutation; null when the file did not exist. */
  readonly baseline: string | null
  /** Content after this session's last mutation. */
  readonly endState: string
  /** True when the content is past the display ceiling and neither side is sent. */
  readonly oversized: boolean
}

/** How one path's revert ended. */
export type RevertStatus = 'reverted' | 'unchanged' | 'conflict' | 'missing'

/** One path's revert outcome. */
export interface RevertFileResult {
  readonly path: string
  readonly status: RevertStatus
  /** Human-readable reason when the revert did not apply cleanly. */
  readonly reason?: string
}

/** Outcome of reverting a whole session, one entry per attempted path. */
export interface RevertResult {
  readonly results: readonly RevertFileResult[]
}

/** Request to list one session's changed files. */
export interface RevisionsListRequest {
  readonly sessionId: SessionId
}

/** Request to read one file's cumulative diff. */
export interface RevisionsDiffRequest {
  readonly sessionId: SessionId
  readonly path: string
}

/** Request to revert one file, or every file the session changed. */
export interface RevisionsRevertRequest {
  readonly sessionId: SessionId
  /** The single path to revert; omitted reverts every changed path. */
  readonly path?: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The session has no recorded revisions for that path. */
    'session-revisions/unknown-path': { readonly path: string }
    /** The path leaves the session's workspace root. */
    'session-revisions/outside-workspace': { readonly path: string }
    /** The session's workspace root could not be resolved. */
    'session-revisions/no-workspace': { readonly sessionId: string }
  }
}
