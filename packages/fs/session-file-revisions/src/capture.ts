/**
 * Capture one session's file revisions from settled tool results.
 *
 * A mutation's own result already carries both sides of what it did: `write`
 * and `edit` return the file's content before and after the call. This module
 * narrows that value and folds it into one record per path, keeping the FIRST
 * `before` as the session baseline and the LAST `after` as the end state.
 *
 * Only the first `before` is kept because the baseline has to be the file's
 * state when the session started touching it — a later call's `before` is this
 * session's own output, not the state the session found. Only the last `after`
 * is kept because intermediate states are superseded the moment the next call
 * lands.
 *
 * @module @deepseek-ai/dsh-session-file-revisions/capture
 */

import type { FileRevision, RevisionOperation } from './types.ts'

/** The wire tool names whose results carry both sides of a file mutation. */
const MUTATION_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])

/**
 * The mutation facts one settled tool result carries, when it has them.
 * `before` is null for a create — the file was not there.
 */
export interface CapturedMutation {
  readonly path: string
  readonly before: string | null
  readonly after: string
  readonly operation: RevisionOperation
}

/** Narrow an unknown tool-result value to the fields a mutation carries. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extract the mutation one settled tool call applied.
 *
 * A `write` reports `operation` and both content sides; an `edit` reports both
 * sides without an operation, so its kind is `edit` by construction. A failed
 * call, a non-mutating tool, and a result missing either side contribute
 * nothing — a partial value cannot bound a revert.
 * @param name - wire tool name of the settled call.
 * @param value - the call's canonical result value.
 * @returns the captured mutation, or null when the call is not an applied mutation.
 */
export function captureMutation(name: string, value: unknown): CapturedMutation | null {
  if (!MUTATION_TOOLS.has(name)) return null
  if (!isRecord(value)) return null
  const path = value['path']
  const after = value['after']
  if (typeof path !== 'string' || path.length === 0) return null
  if (typeof after !== 'string') return null
  const before = value['before']
  return {
    path,
    before: typeof before === 'string' ? before : null,
    after,
    operation: name === 'write' ? 'write' : 'edit',
  }
}

/**
 * Fold one captured mutation into a path's revision record.
 *
 * The first mutation of a path fixes its baseline and operation; every later
 * one only advances the end state and the last seq. Folding by seq rather than
 * by arrival keeps the result independent of the order calls settle in.
 * @param existing - the path's record so far, or undefined for the first mutation.
 * @param mutation - the mutation to fold in.
 * @param seq - the seq this mutation settled at.
 * @returns the next record.
 */
export function foldMutation(
  existing: FileRevision | undefined,
  mutation: CapturedMutation,
  seq: number,
): FileRevision {
  if (existing === undefined) {
    return {
      path: mutation.path,
      baseline: mutation.before,
      endState: mutation.after,
      operation: mutation.operation,
      firstSeq: seq,
      lastSeq: seq,
    }
  }
  // Both bounds fold by seq, so the result is independent of the order calls
  // settle in: the newest mutation owns the end state and the oldest owns the
  // baseline. Arrival order would let a re-delivered late result move the end
  // state backwards and hide a change from the reader.
  const isNewest = seq >= existing.lastSeq
  return {
    ...existing,
    endState: isNewest ? mutation.after : existing.endState,
    firstSeq: Math.min(existing.firstSeq, seq),
    lastSeq: Math.max(existing.lastSeq, seq),
  }
}
