/**
 * The `changedFiles` projection unit: the whole-log changed-file list served
 * to every client carrier.
 *
 * The client window fold can only fold the events a page actually loaded, so
 * a Turn whose mutations sit outside the loaded page discloses nothing — the
 * reader sees a list that looks like "this request" in a long Session and
 * "the whole Session" in a short one. This unit folds the complete durable log
 * on the host instead, so the list is the Session's real change set however
 * much history the client has paged in.
 *
 * @module @deepseek-ai/dsh-file-changes/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { changedFilesView, stepFileChanges, type FileChangesState } from './fold.ts'
import type { ChangedFilesProjection } from './types.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    changedFiles: FileChangesState
  }
}

/** Fold state as it survives a checkpoint: plain JSON, per the unit contract. */
const fileChangesStateSchema: z.ZodType<FileChangesState> = z.object({
  cwd: z.string().nullable(),
  files: z.record(z.string(), z.object({
    operation: z.union([z.literal('write'), z.literal('edit')]),
    firstSeq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
  }).strict()),
  pending: z.record(z.string(), z.object({
    turn: z.number().int().nonnegative(),
    path: z.string(),
    operation: z.union([z.literal('write'), z.literal('edit')]),
  }).strict()),
}).strict()

/** Wire payload the client reads: the whole current list, in first-seen order. */
const changedFilesViewSchema: z.ZodType<ChangedFilesProjection> = z.object({
  files: z.array(z.object({
    path: z.string(),
    operation: z.union([z.literal('write'), z.literal('edit')]),
    firstSeq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
  }).strict()),
}).strict()

/**
 * The changed-files projection unit.
 *
 * `init` captures the Workspace root from the immutable Session header, which
 * is what lets every later `apply` stay a pure function of (state, event).
 */
export const changedFilesProjectionDefinition = {
  key: 'changedFiles',
  stateVersion: 1,
  stateSchema: fileChangesStateSchema,
  init: (header: SessionHeader): FileChangesState => ({
    cwd: header.cwd ?? null,
    files: {},
    pending: {},
  }),
  apply: stepFileChanges,
  wire: { viewSchema: changedFilesViewSchema, view: changedFilesView },
} satisfies ProjectionDefinition<'changedFiles', FileChangesState>
