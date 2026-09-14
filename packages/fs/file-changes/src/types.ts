/**
 * Pure types of the file-changes domain: the ONE home of the `changedFiles`
 * projection-key declaration, free of this package's host-side value imports
 * (cordis context, zod). Two namespace projections serve it — `./types` for
 * host consumers, `./client` for client aggregates — with zero content
 * duplication.
 *
 * @module @deepseek-ai/dsh-file-changes/types
 */

// Marks this file a module so the declaration below AUGMENTS the projection
// table instead of declaring an ambient module.
export {}

/** A mutation's user-visible kind: `write` (new/overwrite) or `edit` (in-place). */
export type FileChangeOperation = 'write' | 'edit'

/**
 * One file's changes across the complete durable log.
 *
 * `firstSeq` is the earliest successful mutation's seq and decides the list's
 * first-seen order; `lastSeq` is the latest one and is what the reader's
 * accept acts against — a path re-enters the pending list exactly when a
 * mutation lands after the seq the reader accepted.
 */
export interface FileChangeEntry {
  /** Canonical absolute path, resolved against the Session Workspace root. */
  path: string
  /** Operation kind of the EARLIEST successful mutation of this path. */
  operation: FileChangeOperation
  /** Seq of the earliest successful mutation of this path. */
  firstSeq: number
  /** Seq of the latest successful mutation of this path. */
  lastSeq: number
}

/** Whole-log changed-file list, in first-seen order. */
export interface ChangedFilesProjection {
  files: readonly FileChangeEntry[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole-log changed files the agent mutated; see {@link ChangedFilesProjection}. */
    changedFiles: ChangedFilesProjection
  }
}
