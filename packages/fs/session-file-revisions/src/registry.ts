/**
 * Per-session revision storage, keyed by session id with subagent aggregation.
 *
 * Records are held per session id, and the session a mutation came from is
 * credited to its ROOT session: a subagent is its own session with its own log,
 * so its changes are the delegating session's changes too. `SessionHeader`
 * carries `parentSession`, so the root is reached by walking up. Without that
 * header — a session with no parent — the session is its own root.
 *
 * The store is bounded by changed paths per session, not by events: each path
 * holds one baseline and one end state.
 *
 * @module @deepseek-ai/dsh-session-file-revisions/registry
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileRevision } from './types.ts'
import { foldMutation, type CapturedMutation } from './capture.ts'

/** Parent lookup for one session id; absent means the session is its own root. */
export type ParentLookup = (sessionId: SessionId) => SessionId | undefined

/**
 * Revision records for every session this store has seen.
 *
 * One map holds every session's own records; reading a session returns its own
 * records merged with every descendant's, so a root session sees the whole
 * delegation tree's changes.
 */
export class SessionRevisionStore {
  /** Own records per session id, insertion-ordered within a session. */
  private readonly own = new Map<SessionId, Map<string, FileRevision>>()
  /** Child session ids per parent, so a root read can include its subtree. */
  private readonly children = new Map<SessionId, Set<SessionId>>()

  /**
   * @param parentOf - resolves one session's parent; undefined makes it a root.
   */
  constructor(private readonly parentOf: ParentLookup) {}

  /**
   * The root session one session's changes are credited to.
   * @param sessionId - the session a mutation came from.
   * @returns the root session id.
   */
  private rootOf(sessionId: SessionId): SessionId {
    const seen = new Set<SessionId>([sessionId])
    let current = sessionId
    for (;;) {
      const parent = this.parentOf(current)
      if (parent === undefined || seen.has(parent)) return current
      seen.add(parent)
      current = parent
    }
  }

  /**
   * Record one mutation a session applied.
   * @param sessionId - the session whose tool call settled.
   * @param mutation - the captured mutation.
   * @param seq - the seq the call settled at.
   */
  record(sessionId: SessionId, mutation: CapturedMutation, seq: number): void {
    const root = this.rootOf(sessionId)
    if (root !== sessionId) {
      const siblings = this.children.get(root) ?? new Set<SessionId>()
      siblings.add(sessionId)
      this.children.set(root, siblings)
    }
    const records = this.own.get(sessionId) ?? new Map<string, FileRevision>()
    records.set(mutation.path, foldMutation(records.get(mutation.path), mutation, seq))
    this.own.set(sessionId, records)
  }

  /**
   * Every revision this session and its descendant subagents recorded, in
   * first-mutation order.
   * @param sessionId - the session to read.
   * @returns the revisions, one per path.
   */
  list(sessionId: SessionId): readonly FileRevision[] {
    const merged = new Map<string, FileRevision>()
    for (const id of this.subtreeOf(sessionId)) {
      for (const revision of this.own.get(id)?.values() ?? []) {
        merged.set(revision.path, mergeRevisions(merged.get(revision.path), revision))
      }
    }
    return [...merged.values()].sort((left, right) => left.firstSeq - right.firstSeq)
  }

  /** This session plus every descendant, breadth-first. */
  private subtreeOf(sessionId: SessionId): readonly SessionId[] {
    const out: SessionId[] = [sessionId]
    const queue: SessionId[] = [sessionId]
    while (queue.length > 0) {
      const next = queue.shift() as SessionId
      for (const child of this.children.get(next) ?? []) {
        if (out.includes(child)) continue
        out.push(child)
        queue.push(child)
      }
    }
    return out
  }

  /**
   * Drop one session's records and its place in its parent's child set.
   * @param sessionId - the session to forget.
   */
  forget(sessionId: SessionId): void {
    this.own.delete(sessionId)
    this.children.delete(sessionId)
    for (const siblings of this.children.values()) siblings.delete(sessionId)
  }
}

/**
 * Merge two sessions' records for one path, keeping the earlier baseline and
 * the later end state.
 *
 * A parent and its subagent can both touch one path; the merged record has to
 * bound both, so the baseline is whichever mutation came first and the end state
 * is whichever came last.
 * @param left - one session's record, or undefined.
 * @param right - the other session's record.
 * @returns the merged record.
 */
export function mergeRevisions(left: FileRevision | undefined, right: FileRevision): FileRevision {
  if (left === undefined) return right
  const firstIsLeft = left.firstSeq <= right.firstSeq
  const lastIsLeft = left.lastSeq >= right.lastSeq
  return {
    path: right.path,
    baseline: firstIsLeft ? left.baseline : right.baseline,
    endState: lastIsLeft ? left.endState : right.endState,
    operation: firstIsLeft ? left.operation : right.operation,
    firstSeq: Math.min(left.firstSeq, right.firstSeq),
    lastSeq: Math.max(left.lastSeq, right.lastSeq),
  }
}
