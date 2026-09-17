/**
 * The session-file-revisions domain declaration: one `sessions` table keyed by
 * {@link SessionId}, each record the whole revision set this session (plus its
 * descendant subagents) recorded.
 *
 * The records are persisted because a revision cannot be replayed from the
 * session log: `tool/result` carries only the rendered text and the tool's own
 * presentation metadata, so the `before`/`after` pair the capture reads lives
 * nowhere but this store. Without persistence the changed-file list — which IS
 * rebuilt from the durable log — would name files whose revision is gone, and
 * every one of them would refuse to open.
 *
 * @module @deepseek-ai/dsh-session-file-revisions/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { FileRevision } from './types.ts'

/**
 * The stored identity a record is bound to: the immutable header fields that
 * distinguish one session lifecycle from another under the same id, plus the
 * parent link the delegation subtree is rebuilt from.
 *
 * A session id names a slot, not a lifecycle. A deleted-then-recreated id, or a
 * persistence root swapped under a surviving store, would otherwise let a
 * record captured from an unrelated log answer for the new session — and a
 * revert built on it would write content the new session never produced.
 *
 * `parentSession` is stored rather than looked up because the live session
 * store holds only the sessions this process has opened: after a restart the
 * parent of a stored subagent record is reachable nowhere else, and without it
 * a subagent's changes would drop out of its root session's list.
 */
export const revisionIdentity = z.object({
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().optional(),
  parentSession: z.string().optional(),
})

/** The identity fields a record is bound to, inferred from {@link revisionIdentity}. */
export type RevisionIdentity = z.infer<typeof revisionIdentity>

/** One revision order position, stored verbatim so cross-session folding survives a restart. */
const revisionOrder = z.object({
  session: z.string(),
  at: z.number(),
  seq: z.number().int().gte(-1),
})

/** One stored revision, shaped to match the live `FileRevision` the capture produces. */
export const storedRevision = z.object({
  path: z.string(),
  baseline: z.string().nullable(),
  origin: z.enum(['existing', 'absent', 'unknown']),
  endState: z.string(),
  operation: z.enum(['write', 'edit']),
  firstOrder: revisionOrder,
  lastOrder: revisionOrder,
})

/** One stored revision, inferred from {@link storedRevision}. */
export type StoredRevision = z.infer<typeof storedRevision>

/**
 * One session's stored revisions.
 *
 * The whole record is replaced on every write (whole-value discipline): the
 * set is the complete cut for that session, so a partial merge would have to
 * re-derive the same fold the capture already performed.
 */
export const revisionRecord = z.object({
  identity: revisionIdentity,
  revisions: z.array(storedRevision),
})

/** One stored per-session revision record, inferred from {@link revisionRecord}. */
export type RevisionRecord = z.infer<typeof revisionRecord>

/**
 * The session-file-revisions domain spec.
 *
 * `per-record` scopes a version bump per session: after a bump a stale session
 * document is discarded on open while the rest of the domain stays usable. A
 * discarded record is a real capability loss rather than a cache miss — the
 * revision it held cannot be replayed — so the layout choice keeps one
 * unreadable document from taking every other session's revisions with it.
 */
export const revisionsDomainSpec = defineDomain({
  name: 'session_file_revisions',
  version: 1,
  layout: 'per-record',
  tables: { sessions: domainTable<SessionId, RevisionRecord>(revisionRecord) },
})

/**
 * Project one live revision onto its stored form.
 *
 * The stored record keeps the session id as a plain string: the medium holds
 * JSON, where the `SessionId` brand does not exist. This pair of functions is
 * the only place that boundary is crossed, so the conversion is stated once
 * rather than cast at each use.
 * @param revision - the captured revision.
 * @returns its stored form.
 */
export function toStoredRevision(revision: FileRevision): StoredRevision {
  return {
    path: revision.path,
    baseline: revision.baseline,
    origin: revision.origin,
    endState: revision.endState,
    operation: revision.operation,
    firstOrder: {
      session: revision.firstOrder.session,
      at: revision.firstOrder.at,
      seq: revision.firstOrder.seq,
    },
    lastOrder: {
      session: revision.lastOrder.session,
      at: revision.lastOrder.at,
      seq: revision.lastOrder.seq,
    },
  }
}

/**
 * Rebuild one live revision from its stored form.
 *
 * A restored record is trusted to have passed the domain's own schema validation
 * at open, which is why the session ids are branded here rather than re-checked.
 * @param stored - the validated record read from the medium.
 * @returns the revision the capture layer would have produced.
 */
export function fromStoredRevision(stored: StoredRevision): FileRevision {
  return {
    path: stored.path,
    baseline: stored.baseline,
    origin: stored.origin,
    endState: stored.endState,
    operation: stored.operation,
    firstOrder: {
      session: SessionId(stored.firstOrder.session),
      at: stored.firstOrder.at,
      seq: stored.firstOrder.seq,
    },
    lastOrder: {
      session: SessionId(stored.lastOrder.session),
      at: stored.lastOrder.at,
      seq: stored.lastOrder.seq,
    },
  }
}
