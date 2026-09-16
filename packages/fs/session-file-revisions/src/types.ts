/**
 * Pure types of the session-file-revisions domain: one session's captured file
 * baselines and end-states, and the results a revert reports.
 *
 * A **baseline** is the file's content when this session (or one of its
 * descendant subagent sessions) first mutated it; `null` means the file did not
 * exist. An **end-state** is the content after this session's last mutation.
 * The pair bounds what this session did, which is what both the displayed diff
 * and the revert act on.
 *
 * @module @deepseek-ai/dsh-session-file-revisions/types
 */

/** Operation kind of the mutation that first touched a path in this session. */
export type RevisionOperation = 'write' | 'edit'

/** Whether a mutated path existed before this session's first mutation. */
export type BaselineOrigin = 'absent' | 'existing'

/**
 * One path's captured revision facts.
 *
 * `baseline` is null when the path did not exist before this session's first
 * mutation, which makes a revert a deletion rather than a rewrite.
 */
export interface FileRevision {
  /** Canonical absolute path; the same spelling the changed-files fold uses. */
  readonly path: string
  /** Content before this session's first mutation, or null when it did not exist. */
  readonly baseline: string | null
  /** Content after this session's last mutation. */
  readonly endState: string
  /** Operation kind of the first mutation. */
  readonly operation: RevisionOperation
  /** Seq of the first mutation; decides the list's first-seen order. */
  readonly firstSeq: number
  /** Seq of the last mutation. */
  readonly lastSeq: number
}

/** Whether a path's content is available for display, and how large it is. */
export interface RevisionSize {
  /** Byte length of the baseline text, or 0 when the path did not exist. */
  readonly baselineBytes: number
  /** Byte length of the end-state text. */
  readonly endStateBytes: number
  /** True when either side exceeds the configured display ceiling. */
  readonly oversized: boolean
}

/** One path's revision with its size facts, as the UI lists it. */
export interface FileRevisionSummary extends RevisionSize {
  readonly path: string
  readonly operation: RevisionOperation
  readonly firstSeq: number
  readonly lastSeq: number
}

/**
 * Outcome of reverting one path.
 *
 * `reverted` means the file's content changed. `unchanged` means the session's
 * end-state already matched the baseline (or the file was already gone), so
 * nothing was written. `conflict` means the reverse patch could not be applied
 * cleanly and the file was left untouched.
 */
export type RevertOutcome =
  | { readonly kind: 'reverted'; readonly path: string }
  | { readonly kind: 'unchanged'; readonly path: string }
  | { readonly kind: 'conflict'; readonly path: string; readonly reason: string }
  | { readonly kind: 'missing'; readonly path: string }
