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

import type { BaselineOrigin, FileRevision, RevisionOperation, RevisionOrder } from './types.ts'

/** The wire tool names whose results carry both sides of a file mutation. */
const MUTATION_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'str_replace_editor'])

/**
 * The mutation facts one settled tool result carries, when it has them.
 * `origin` says what the call found at the path, which is what decides whether
 * a revert may delete it.
 */
export interface CapturedMutation {
  readonly path: string
  readonly baseline: string | null
  readonly origin: BaselineOrigin
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
 * A `write` and the mutating `str_replace_editor` commands report both content
 * sides plus a self-reported `operation`; an `edit` reports both sides without
 * one, so its kind is `edit` by construction. A failed call, a non-mutating
 * tool, and a result missing `after` contribute nothing.
 *
 * A missing `before` is ambiguous, and reading it as "the file was not there"
 * is what would make a revert delete a file this session never created. Only a
 * report of `operation: 'create'` proves the file really was absent; every other
 * missing side is `unknown`, which a revert reports as a conflict rather than
 * guessing at. A tool that declares both sides mandatory (`edit`) can never
 * produce a genuine create, so a missing one there is not a mutation this plugin
 * can act on.
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
  const operation: RevisionOperation = name === 'write' ? 'write' : 'edit'
  const before = value['before']
  if (typeof before === 'string') {
    return { path, baseline: before, origin: 'existing', after, operation }
  }
  // `edit` requires both sides in its result schema, so a missing one there is
  // not a create this plugin can act on.
  if (name === 'edit') return null
  return value['operation'] === 'create'
    ? { path, baseline: null, origin: 'absent', after, operation }
    : { path, baseline: null, origin: 'unknown', after, operation }
}

/**
 * Fold one captured mutation into a path's revision record.
 *
 * The first mutation of a path fixes its baseline, origin, and operation; every
 * later one only advances the end state and the last seq. Folding by seq rather
 * than by arrival keeps the result independent of the order calls settle in.
 *
 * A later mutation whose baseline could not be captured does not erase an
 * earlier usable one: this session may have read the file at its first
 * mutation, in which case that content is still the honest starting point even
 * though a bulky later overwrite could not report its own.
 * @param existing - the path's record so far, or undefined for the first mutation.
 * @param mutation - the mutation to fold in.
 * @param order - the position this mutation settled at.
 * @returns the next record.
 */
export function foldMutation(
  existing: FileRevision | undefined,
  mutation: CapturedMutation,
  order: RevisionOrder,
): FileRevision {
  if (existing === undefined) {
    return {
      path: mutation.path,
      baseline: mutation.baseline,
      origin: mutation.origin,
      endState: mutation.after,
      operation: mutation.operation,
      firstOrder: order,
      lastOrder: order,
    }
  }
  // Both bounds fold by position, so the result is independent of the order
  // calls settle in: the newest mutation owns the end state and the oldest owns
  // the baseline. Arrival order would let a re-delivered late result move the
  // end state backwards and hide a change from the reader.
  const isNewest = compareOrder(order, existing.lastOrder) >= 0
  const isOldest = compareOrder(order, existing.firstOrder) < 0
  // Only an older mutation may replace the baseline, and only with a capture it
  // actually made: downgrading a known baseline to `unknown` would turn a
  // revertible file into a conflict for no gain.
  const takesBaseline = isOldest && mutation.origin !== 'unknown'
  return {
    ...existing,
    ...takesBaseline
      ? { baseline: mutation.baseline, origin: mutation.origin, operation: mutation.operation }
      : {},
    endState: isNewest ? mutation.after : existing.endState,
    firstOrder: isOldest ? order : existing.firstOrder,
    lastOrder: isNewest ? order : existing.lastOrder,
  }
}

/**
 * Order two mutations across sessions.
 *
 * Inside one session seq is authoritative, because it is what makes folding
 * independent of the order results arrive in. Across sessions the two logs
 * number themselves independently (a forked child starts at its seed length),
 * so the settle instant is the only shared ordering.
 * @param left - one mutation's position.
 * @param right - the other's.
 * @returns negative when `left` is earlier, positive when later, 0 when equal.
 */
export function compareOrder(left: RevisionOrder, right: RevisionOrder): number {
  if (left.session === right.session) return left.seq - right.seq
  if (left.at !== right.at) return left.at - right.at
  // Distinct sessions settling in the same millisecond have no shared order;
  // fall back to the session id so the result stays deterministic rather than
  // depending on which record happened to arrive first.
  return left.session < right.session ? -1 : 1
}
