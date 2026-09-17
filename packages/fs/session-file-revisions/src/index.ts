/**
 * Session-file-revisions service: capture every file a session mutated together
 * with the content it had before this session first touched it, so a session's
 * changes can be shown and reverted.
 *
 * Capture rides `tools/post-execute` — the one point where a mutation's own
 * result still carries both content sides — so this plugin adds no behavior to
 * `dsh-tool-fs` and never reads a file itself.
 *
 * A revision is DURABLE. The pair it holds cannot be replayed from the session
 * log (`tool/result` carries only the rendered text and the tool's own
 * presentation metadata), while the changed-file list the surface shows can be.
 * Persisting is therefore what keeps the two views of one session's work
 * consistent across a restart instead of offering files whose revision is gone.
 *
 * @module @deepseek-ai/dsh-session-file-revisions
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { captureMutation } from './capture.ts'
import { SessionRevisionStore } from './registry.ts'
import {
  fromStoredRevision, revisionsDomainSpec, toStoredRevision,
  type RevisionIdentity, type RevisionRecord,
} from './spec.ts'
import type { FileRevision } from './types.ts'

export {
  captureMutation, compareOrder, foldMutation, type CapturedMutation,
} from './capture.ts'
export { mergeRevisions, SessionRevisionStore, type ParentLookup } from './registry.ts'
export { revertContent, type RevertResult } from './revert.ts'
export type { RevisionIdentity, RevisionRecord } from './spec.ts'
export type {
  BaselineOrigin, FileRevision, RevisionOperation, RevisionOrder,
} from './types.ts'

/**
 * Inclusive byte ceiling of one session's stored revision record.
 *
 * One record holds both content sides of every file the session changed, so it
 * grows with the session's own work rather than with the number of sessions.
 * A record above this bound is not written, which costs that session its
 * persisted revisions; the alternative — truncating — would store a baseline
 * that no longer describes the file and let a revert write content the session
 * never produced.
 */
export const DEFAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024

/** Plugin config. */
export interface Config {
  /**
   * Inclusive byte ceiling of one session's stored revision record; absent uses
   * {@link DEFAULT_MAX_RECORD_BYTES}. A record above it is not persisted, which
   * costs that session its revisions across a restart.
   */
  maxRecordBytes?: number
}

/** Validated plugin config; the cap is optional so an absent value resolves to the default. */
export const Config: z<Config> = z.object({
  maxRecordBytes: z.natural().default(DEFAULT_MAX_RECORD_BYTES),
})

/** Structural view of the session a tool execution carries. */
interface RevisionExec {
  readonly agent?: {
    readonly session?: {
      readonly header: {
        readonly id: SessionId
        readonly parentSession?: SessionId
        readonly createdAt?: number
        readonly cwd?: string
      }
      readonly seq: number
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-session captured file revisions. */
    sessionFileRevisions: SessionFileRevisions
  }
}

/**
 * Per-session captured file revisions.
 *
 * Reading a session returns its own records merged with its subagents', because
 * a subagent's changes are the delegating session's changes too.
 */
export class SessionFileRevisions extends Service {
  static inject = ['tools', 'sessions', 'storageDomain']

  /** The stored-record table; absent until the domain opens. */
  private table: KvTable<SessionId, RevisionRecord> | undefined

  /**
   * @param ctx - host context carrying the tool runtime, session store, and storage.
   * @param config - validated plugin config. A composition that declares no
   * `config` on this plugin's row passes `undefined`, which is the shipped
   * shape; every field therefore resolves against its own default rather than
   * being read off an object that may not be there.
   */
  constructor(ctx: Context, public config?: Config) {
    super(ctx, 'sessionFileRevisions')
    this.store = new SessionRevisionStore(
      id => this.ctx.sessions.get(id)?.header.parentSession,
    )
    ctx.on('tools/post-execute', async (
      exec: ToolExecution,
      result: ToolExecutionResult,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      // Delegate first: a downstream listener may replace or block the result,
      // and capture follows whatever it accepted.
      const decision = await next()
      if (result.isError) return decision
      const owner = (exec as RevisionExec).agent?.session
      if (owner === undefined) return decision
      const mutation = captureMutation(exec.name, result.value)
      if (mutation === null) return decision
      // Order by the settle instant rather than the session's own seq: each
      // session numbers its own log, so a subagent's seq is not comparable with
      // its parent's. The session id and seq keep the order total.
      this.store.record(owner.header.id, mutation, {
        session: owner.header.id,
        at: Date.now(),
        seq: owner.seq,
      })
      // Awaited here rather than left to teardown: this listener is the only
      // moment the session is guaranteed to still be open, and a write still
      // settling as the medium closes is a write that never lands.
      await this.persist(owner.header.id, owner.header)
      return decision
    })
  }

  private readonly store: SessionRevisionStore

  /**
   * The identity each restored record was bound to, so a live session can be
   * checked against the lifecycle its records came from.
   *
   * Only restored records appear here: a record written by this process was
   * captured from the live session, so its identity is already known to agree.
   */
  private readonly restoredIdentity = new Map<SessionId, RevisionIdentity>()

  /**
   * Tail of the write chain per session, so a session's record writes land in
   * issue order. See {@link enqueueWrite} for why the order matters.
   */
  private readonly writes = new Map<SessionId, Promise<void>>()

  /**
   * Open the domain and restore every stored record before the first read.
   *
   * Restoring at init rather than lazily keeps {@link list} synchronous, which
   * is what lets the Remote layer answer without threading an await through
   * every read.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(revisionsDomainSpec)
    this.ctx.effect(() => () => {
      // Writes are awaited where they are issued, so this drain is a safety net
      // for any chain still settling rather than the mechanism that makes a
      // record durable. A job left running as the medium closes would be refused
      // by it and silently cost the session its revisions.
      return (async () => {
        await Promise.allSettled([...this.writes.values()])
        await domain.close()
      })()
    }, 'sessionFileRevisions.domainClose')
    this.table = domain.table('sessions')
    let restored = 0
    for (const [id, record] of this.table.entries()) {
      const parent = record.identity.parentSession
      this.store.seed(
        id,
        parent === undefined ? undefined : toSessionId(parent),
        record.revisions.map(fromStoredRevision),
      )
      this.restoredIdentity.set(id, record.identity)
      restored += 1
    }
    // Every record is in before the links are computed: a child restored ahead
    // of its parent would otherwise be filed under a parent that was still a
    // root, and the order records were written in must not decide the tree.
    this.store.rebuildTree()
    if (restored > 0) {
      this.ctx.logger.debug(`session file revisions: restored ${String(restored)} session record(s)`)
    }
  }

  /**
   * Whether a restored record still describes the session that currently holds
   * this id.
   *
   * A session id names a slot, not a lifecycle: a session deleted and recreated
   * under the same id would otherwise inherit the previous lifecycle's
   * baselines, and a revert derived from them would restore content the current
   * session never had. A disagreement retires the record instead of serving it.
   * @param sessionId - the session being read.
   * @returns true when the record may answer for this session.
   */
  private identityHolds(sessionId: SessionId): boolean {
    const stored = this.restoredIdentity.get(sessionId)
    if (stored === undefined) return true
    const header = this.ctx.sessions.get(sessionId)?.header
    // No live header means nothing to contradict the record: a cold read of a
    // session this process has not opened is exactly what persistence is for.
    if (header === undefined) return true
    if (header.createdAt !== stored.createdAt) {
      this.retire(sessionId)
      return false
    }
    return true
  }

  /**
   * Every restored session in a subtree whose record still matches the live
   * session holding that id.
   *
   * The whole subtree is checked, not just the queried session: a read merges
   * a root with its descendants' records, so one recreated child id would
   * otherwise contribute baselines captured from the log it replaced — and a
   * revert built on those would restore content no live session ever had.
   * @param sessionId - the session whose subtree is read.
   * @returns the subtree ids, after each member's identity has been checked.
   */
  private validatedSubtree(sessionId: SessionId): readonly SessionId[] {
    const subtree = this.store.subtreeOf(sessionId)
    for (const id of subtree) this.identityHolds(id)
    return subtree
  }

  /**
   * Discard one session's restored record and everything derived from it.
   * @param sessionId - the session whose record is retired.
   */
  private retire(sessionId: SessionId): void {
    this.restoredIdentity.delete(sessionId)
    this.store.forget(sessionId)
    void this.enqueueWrite(sessionId, undefined)
  }

  /**
   * Every file this session or its subagents mutated, in first-mutation order.
   * @param sessionId - the session to read.
   * @returns one revision per path.
   */
  list(sessionId: SessionId): readonly FileRevision[] {
    // Every member of the merged subtree is validated, not just the queried
    // session: a recreated child id would otherwise contribute baselines from
    // the log it replaced into this root's answer.
    this.validatedSubtree(sessionId)
    return this.store.list(sessionId)
  }

  /**
   * Drop one reverted path's revision from this session's subtree.
   *
   * A successfully reverted path no longer holds this session's change, so
   * leaving its record behind would keep offering a file with nothing left to
   * show or undo — and once persisted, that stale offer would survive every
   * restart.
   * @param sessionId - the session whose path was reverted.
   * @param path - the canonical path to drop.
   */
  async dropPath(sessionId: SessionId, path: string): Promise<void> {
    const changed = this.store.dropPath(sessionId, path)
    await Promise.all(changed.map(async (id) => {
      await this.persist(id, this.ctx.sessions.get(id)?.header)
    }))
  }

  /**
   * Drop one session's records and its subagents' link to it.
   * @param sessionId - the session to forget.
   */
  forget(sessionId: SessionId): Promise<void> {
    this.store.forget(sessionId)
    this.restoredIdentity.delete(sessionId)
    return this.enqueueWrite(sessionId, undefined)
  }

  /**
   * Write one session's own record back to the domain.
   *
   * The record is re-read when the job runs, not when it is queued: the store is
   * the authority, so a later capture's revision set supersedes an earlier
   * queueing rather than being overwritten by it.
   *
   * Fail-soft: a record that cannot be written costs the revisions of one
   * session across the next restart, where failing the tool call would refuse
   * work that already landed on disk.
   * @param sessionId - the session whose record is written.
   * @param header - that session's header, captured now because the session may
   * be retired before the job runs.
   */
  private persist(sessionId: SessionId, header: RevisionHeader | undefined): Promise<void> {
    return this.enqueueWrite(sessionId, header)
  }

  /**
   * Queue one session's record write behind every write already issued for it.
   *
   * The ordering is the whole point. A table `delete` decides from the domain's
   * in-memory state and skips the medium write when the key looks absent — so a
   * delete issued while an earlier `put` is still queued would do nothing at all,
   * and the queued put would then land the record the delete was meant to
   * remove. Serializing per session makes each job observe the outcome of the
   * one before it, so a retire always wins over the write it supersedes.
   * @param sessionId - the session whose record is written.
   * @param header - the session's header at issue time, or undefined once retired.
   */
  private enqueueWrite(sessionId: SessionId, header: RevisionHeader | undefined): Promise<void> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const table = this.table
      if (table === undefined) return
      const revisions = this.store.ownRevisions(sessionId)
      if (revisions.length === 0) {
        await table.delete(sessionId)
        return
      }
      const record: RevisionRecord = {
        identity: identityOf(header),
        revisions: revisions.map(toStoredRevision),
      }
      const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8')
      if (bytes > this.maxRecordBytes) {
        this.ctx.logger.warn(
          `session file revisions: record for "${sessionId}" is about ${String(bytes)} bytes, above the `
          + `${String(this.maxRecordBytes)}-byte cap; not persisted (this session's changes stay viewable `
          + 'until the process exits)',
        )
        // A truncated baseline would let a revert write content the session never
        // made, so an over-cap record is removed rather than shortened.
        await table.delete(sessionId)
        return
      }
      await table.put(sessionId, record)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`session file revisions: could not persist the record for "${sessionId}": ${String(error)}`)
    })
    this.writes.set(sessionId, next)
    // Drop the settled tail so the map is bounded by the writes still in
    // flight rather than by every session this process ever wrote. Only the
    // entry this call installed is removed: a later write has already replaced
    // it, and clearing that one would let two jobs run concurrently.
    void next.then(() => {
      if (this.writes.get(sessionId) === next) this.writes.delete(sessionId)
    })
    return next
  }

  /**
   * The configured record cap.
   *
   * Read through the session's own header when it is live; otherwise the
   * default holds, so a write triggered after a session retired still has a
   * bound rather than none.
   */
  private get maxRecordBytes(): number {
    return this.config?.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
  }
}

/** The header fields a stored record binds to, as the capture reads them. */
interface RevisionHeader {
  readonly id: SessionId
  readonly parentSession?: SessionId
  readonly createdAt?: number
  readonly cwd?: string
}

/**
 * The identity one session's record binds to.
 *
 * The parent link is the field that matters on a cold start: the live session
 * store answers only for sessions this process opened, so a restored subagent
 * record would otherwise lose its place in its root session's subtree.
 * @param header - the session's live header, when the session is still open.
 * @returns the identity fields.
 */
function identityOf(header: RevisionHeader | undefined): RevisionIdentity {
  return {
    createdAt: header?.createdAt ?? 0,
    ...header?.cwd === undefined ? {} : { cwd: header.cwd },
    ...header?.parentSession === undefined ? {} : { parentSession: header.parentSession },
  }
}

export default SessionFileRevisions
