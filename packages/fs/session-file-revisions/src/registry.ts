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
import type { FileRevision, RevisionOrder } from './types.ts'
import { compareOrder, foldMutation, type CapturedMutation } from './capture.ts'

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
  /** Child session ids per root, so a root read can include its subtree. */
  private readonly children = new Map<SessionId, Set<SessionId>>()
  /**
   * Parent links, from live sessions and from restored records.
   *
   * A restored record must carry its own link: after a restart the live store
   * holds only the sessions this process has opened, so a stored subagent's
   * parent is otherwise unreachable and its changes would drop out of the root
   * session's list.
   */
  private readonly parents = new Map<SessionId, SessionId>()

  /**
   * @param parentOf - resolves one session's parent from the live store;
   * undefined when it is a root or unknown.
   */
  constructor(private readonly parentOf: ParentLookup) {}

  /** One session's parent, preferring a link already learned over the live lookup. */
  private parentOfSession(sessionId: SessionId): SessionId | undefined {
    const known = this.parents.get(sessionId)
    if (known !== undefined) return known
    return this.parentOf(sessionId)
  }

  /**
   * The root session one session's changes are credited to.
   * @param sessionId - the session a mutation came from.
   * @returns the root session id.
   */
  private rootOf(sessionId: SessionId): SessionId {
    const seen = new Set<SessionId>([sessionId])
    let current = sessionId
    for (;;) {
      const parent = this.parentOfSession(current)
      if (parent === undefined || seen.has(parent)) return current
      seen.add(parent)
      current = parent
    }
  }

  /**
   * Record one mutation a session applied.
   * @param sessionId - the session whose tool call settled.
   * @param mutation - the captured mutation.
   * @param order - the position the call settled at, comparable across sessions.
   */
  record(sessionId: SessionId, mutation: CapturedMutation, order: RevisionOrder): void {
    const root = this.rootOf(sessionId)
    if (root !== sessionId) {
      const siblings = this.children.get(root) ?? new Set<SessionId>()
      siblings.add(sessionId)
      this.children.set(root, siblings)
    }
    const records = this.own.get(sessionId) ?? new Map<string, FileRevision>()
    records.set(mutation.path, foldMutation(records.get(mutation.path), mutation, order))
    this.own.set(sessionId, records)
  }

  /**
   * Restore one session's persisted records and its stored parent link.
   *
   * Seeding does not register the child under its root: a batch is seeded in no
   * guaranteed order, so a child restored before its parent would be filed under
   * the parent that was a root at that moment. {@link rebuildTree} recomputes
   * every link once the batch is in, which makes the result independent of the
   * order the records were stored in.
   * @param sessionId - the session the records belong to.
   * @param parent - the parent the record was captured under, when it had one.
   * @param revisions - the session's own revisions.
   */
  seed(sessionId: SessionId, parent: SessionId | undefined, revisions: readonly FileRevision[]): void {
    if (parent !== undefined) this.parents.set(sessionId, parent)
    if (revisions.length === 0) return
    const records = new Map<string, FileRevision>()
    for (const revision of revisions) records.set(revision.path, revision)
    this.own.set(sessionId, records)
  }

  /** Recompute every root→child link from the seeded records and parent links. */
  rebuildTree(): void {
    this.children.clear()
    for (const sessionId of this.own.keys()) {
      const root = this.rootOf(sessionId)
      if (root === sessionId) continue
      const siblings = this.children.get(root) ?? new Set<SessionId>()
      siblings.add(sessionId)
      this.children.set(root, siblings)
    }
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
    return [...merged.values()].sort((left, right) => compareOrder(left.firstOrder, right.firstOrder))
  }

  /**
   * This session plus every descendant, breadth-first.
   *
   * Public because a read merges the whole subtree, so a caller validating
   * restored records has to reach every member — not only the queried root.
   * @param sessionId - the session to walk from.
   * @returns the subtree's session ids, starting with the given session.
   */
  subtreeOf(sessionId: SessionId): readonly SessionId[] {
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
    this.parents.delete(sessionId)
    this.children.delete(sessionId)
    for (const siblings of this.children.values()) siblings.delete(sessionId)
  }

  /**
   * One session's own revisions, without its descendants'.
   *
   * The persistence layer writes each session's own record: a read merges a
   * subtree into one answer, but a record is stored per session so a child's
   * revisions survive under their own identity.
   * @param sessionId - the session to read.
   * @returns its own records.
   */
  ownRevisions(sessionId: SessionId): readonly FileRevision[] {
    return [...this.own.get(sessionId)?.values() ?? []]
  }

  /**
   * Remove one path's revision from every session holding it, so a reverted
   * path stops being offered.
   *
   * The path is removed from the whole subtree rather than from the queried
   * session alone: a root read merges its children's records, so a child's copy
   * would reappear in the very list the removal is meant to settle.
   * @param sessionId - the session whose subtree is affected.
   * @param path - the canonical path to drop.
   * @returns the sessions whose records changed.
   */
  dropPath(sessionId: SessionId, path: string): readonly SessionId[] {
    const changed: SessionId[] = []
    for (const id of this.subtreeOf(sessionId)) {
      const records = this.own.get(id)
      if (records === undefined || !records.delete(path)) continue
      if (records.size === 0) this.own.delete(id)
      changed.push(id)
    }
    return changed
  }
}

/**
 * Merge two sessions' records for one path, keeping the earlier baseline and
 * the later end state.
 *
 * A parent and its subagent can both touch one path; the merged record has to
 * bound both, so the baseline is whichever mutation came first and the end state
 * is whichever came last. The comparison is on {@link RevisionOrder} rather than
 * raw seq, because the two sessions number their own logs independently.
 * @param left - one session's record, or undefined.
 * @param right - the other session's record.
 * @returns the merged record.
 */
export function mergeRevisions(left: FileRevision | undefined, right: FileRevision): FileRevision {
  if (left === undefined) return right
  const firstIsLeft = compareOrder(left.firstOrder, right.firstOrder) <= 0
  const lastIsLeft = compareOrder(left.lastOrder, right.lastOrder) >= 0
  return {
    path: right.path,
    baseline: firstIsLeft ? left.baseline : right.baseline,
    origin: firstIsLeft ? left.origin : right.origin,
    endState: lastIsLeft ? left.endState : right.endState,
    operation: firstIsLeft ? left.operation : right.operation,
    firstOrder: firstIsLeft ? left.firstOrder : right.firstOrder,
    lastOrder: lastIsLeft ? left.lastOrder : right.lastOrder,
  }
}
