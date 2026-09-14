/**
 * Whole-log changed-file fold: every successful first-party file mutation the
 * Session log recorded, collapsed to one entry per canonical path.
 *
 * The fold is incremental and keeps NO event-proportional state. Two
 * accumulators are bounded by different things and neither grows with the log:
 * `files` holds one record per distinct mutated path, and `pending` holds only
 * the mutation calls still awaiting their result — an entry leaves it the
 * moment its `tool/result` lands, and a turn boundary drops whatever its
 * interrupted calls left behind. That bound is a hard requirement, not a
 * micro-optimization: the state is checkpointed to the projection cache, so a
 * per-event accumulator would put a whole Session log in every checkpoint
 * document. A single Turn can span an entire Session (one prompt, one long
 * autonomous run), which is exactly the shape that makes event-proportional
 * state unbounded.
 *
 * @module @deepseek-ai/dsh-file-changes/fold
 */

import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mutationTarget } from './mutation.ts'
import { canonicalMutationPath } from './path.ts'
import type { ChangedFilesProjection, FileChangeEntry, FileChangeOperation } from './types.ts'

/** One path's accumulated facts. */
interface FileChangeRecord {
  /** Operation kind of the earliest successful mutation; later ones never rewrite it. */
  operation: FileChangeOperation
  firstSeq: number
  lastSeq: number
}

/** One mutation call awaiting its result. */
interface PendingMutation {
  /** Turn that issued the call, so an interrupted turn can drop its leftovers. */
  turn: number
  /** Already-canonical path. */
  path: string
  operation: FileChangeOperation
}

/**
 * Fold state: immutable Session facts plus the two bounded accumulators.
 *
 * `cwd` is captured once from the Session header — the Workspace root cannot
 * change within a Session — which keeps `apply` a pure function of its two
 * arguments.
 */
export interface FileChangesState {
  /** Session Workspace root, or null when the Session has none. */
  cwd: string | null
  files: Record<string, FileChangeRecord>
  pending: Record<string, PendingMutation>
}

/**
 * Whether one `tool/result` records a mutation that actually landed.
 *
 * A result counts only when it appended to the surface and its first content
 * block is not flagged as an error: a failed call changed nothing, and a
 * replacement-origin result belongs to a shadowed span rather than to the
 * transcript's own history.
 * @param event - the `tool/result` event to inspect.
 * @returns true when this result proves its mutation applied.
 */
function isAppliedResult(event: SessionEvent<'tool/result'>): boolean {
  if (!isAppendSurfaceEvent(event)) return false
  return event.data.message.content[0].isError !== true
}

/**
 * Record one applied mutation, preserving the earliest operation and seq.
 * @param files - current per-path records.
 * @param path - canonical path.
 * @param operation - the applied call's operation kind.
 * @param seq - the applying `tool/result` seq.
 * @returns the next records, or the same reference when nothing changed.
 */
function recordMutation(
  files: Record<string, FileChangeRecord>,
  path: string,
  operation: FileChangeOperation,
  seq: number,
): Record<string, FileChangeRecord> {
  const previous = files[path]
  if (previous === undefined) {
    return { ...files, [path]: { operation, firstSeq: seq, lastSeq: seq } }
  }
  // Fold by seq rather than by arrival: the EARLIEST mutation owns the
  // operation kind and `firstSeq`, the LATEST owns `lastSeq`. Replay normally
  // delivers events in order, so this rarely differs from "the newest wins" —
  // but making it order-independent means a resumed or repaired replay cannot
  // move `lastSeq` backwards, which would hide a change the reader has not
  // accepted.
  return {
    ...files,
    [path]: {
      // Fold by seq rather than by arrival: the EARLIEST mutation owns the
      // operation kind and `firstSeq`, the LATEST owns `lastSeq`. Replay
      // normally delivers events in order, so this rarely differs from "the
      // newest wins" — but making it order-independent means a resumed or
      // repaired replay cannot move `lastSeq` backwards, which would hide a
      // change the reader has not accepted.
      //
      // Strictly-earlier only: an equal seq is the same mutation re-delivered,
      // so the operation already recorded stays.
      operation: seq < previous.firstSeq ? operation : previous.operation,
      firstSeq: Math.min(previous.firstSeq, seq),
      lastSeq: Math.max(previous.lastSeq, seq),
    },
  }
}

/**
 * Fold one committed Session event into the changed-file state.
 *
 * A `tool/call` naming a supported mutation becomes pending; its successful
 * `tool/result` records the change and clears the pending entry. A failed
 * result, an unsupported tool, a malformed call, and every unrelated event
 * leave the state untouched — returned as the SAME reference, so an
 * uninterested event produces zero downstream work.
 * @param state - the state covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next state.
 */
export function stepFileChanges(state: FileChangesState, event: SessionEvent): FileChangesState {
  if (event.type === 'tool/call') {
    const target = mutationTarget(event.data.name, event.data.arguments)
    if (target === null) return state
    const callId = String(event.data.callId)
    return {
      ...state,
      pending: {
        ...state.pending,
        [callId]: {
          turn: event.data.turn,
          path: canonicalMutationPath(target.path, state.cwd ?? undefined),
          operation: target.operation,
        },
      },
    }
  }

  if (event.type === 'tool/result') {
    const callId = String(event.data.message.source.callId)
    const pending = state.pending[callId]
    if (pending === undefined) return state
    const { [callId]: _settled, ...remaining } = state.pending
    if (!isAppliedResult(event)) return { ...state, pending: remaining }
    return {
      cwd: state.cwd,
      files: recordMutation(state.files, pending.path, pending.operation, event.seq),
      pending: remaining,
    }
  }

  if (event.type === 'turn/end') {
    // An interrupted turn's calls never settle; drop them rather than let the
    // accumulator grow with every aborted mutation attempt.
    const kept = Object.entries(state.pending).filter(([, entry]) => entry.turn !== event.data.turn)
    if (kept.length === Object.keys(state.pending).length) return state
    return { ...state, pending: Object.fromEntries(kept) }
  }

  return state
}

/**
 * Read the current changed-file list in first-seen order.
 *
 * Ordering is by `firstSeq` rather than by key insertion, so the list is
 * identical however the fold was driven — a fresh replay, a resumed
 * checkpoint, or an incremental live tail.
 * @param state - current fold state.
 * @returns the changed files, one entry per canonical path.
 */
export function changedFilesView(state: FileChangesState): ChangedFilesProjection {
  const files: FileChangeEntry[] = Object.entries(state.files)
    .map(([path, record]): FileChangeEntry => ({
      path,
      operation: record.operation,
      firstSeq: record.firstSeq,
      lastSeq: record.lastSeq,
    }))
    .sort((left, right) => left.firstSeq - right.firstSeq)
  return { files }
}
