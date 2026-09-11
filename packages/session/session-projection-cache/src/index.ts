/**
 * Persisted projection cache (`ctx.sessionProjectionCache`): durable
 * checkpoints of every projection unit's state, one record per session on
 * the `session_projcache` domain (`per-record` layout — the shipped json
 * backend stores one document per session under its root). Reads and writes
 * share ONE coherent state: the domain's in-memory tables serve every read
 * synchronously, and each write lands on the domain's write chain (durability
 * first, then memory), so a read can never observe a disk write the memory
 * has not applied, or a memory value the disk does not hold. The cache is a
 * fold shortcut, never an authority: a row
 * is possibly stale (its `seq` says how stale) but never wrong, so every
 * write path is fail-soft (a lost write costs a longer tail replay on the
 * next cold read) and a `ver` mismatch discards the row instead of migrating
 * it. Design authority: the session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md).
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  ProjectionCheckpoint,
  ProjectionSnapshot,
  SessionProjectionMap,
} from '@deepseek-ai/dsh-session-projection'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { projectionCacheDomainSpec } from './spec.ts'
import type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

export { checkpointIdentity, checkpointRecord, checkpointRow, projectionCacheDomainSpec } from './spec.ts'
export type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the three mandatory write points (session creation,
 * `turn/end`, and session disposal) are policy, not tunables, and always
 * fire.
 */
export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
  /**
   * Largest checkpoint document worth caching, in estimated JSON bytes; `0`
   * caches any size, and an absent value uses {@link DEFAULT_MAX_ROW_BYTES}.
   * A larger row is never written and an already-stored one is dropped. One
   * row is resident for every session the medium holds, so this is the bound
   * that keeps one pathological projection state from costing its whole size
   * per session.
   */
  maxRowBytes?: number
  /**
   * Total resident checkpoint bytes the cache keeps; `0` keeps every row, and
   * an absent value uses {@link DEFAULT_BUDGET_BYTES}. Over budget, the
   * coldest rows are dropped, which is what makes this service's memory a
   * budget rather than a function of the session count. A row whose session is
   * still attached is never a victim, so the budget is soft while every row
   * belongs to a live session.
   */
  budgetBytes?: number
}

/** Default per-row cap: generous for a projection state, far below a session's own log. */
export const DEFAULT_MAX_ROW_BYTES = 4 * 1024 * 1024

/** Default resident budget: holds every ordinary deployment's rows, and far less than the heap. */
export const DEFAULT_BUDGET_BYTES = 64 * 1024 * 1024

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
  maxRowBytes: z.natural().default(DEFAULT_MAX_ROW_BYTES),
  budgetBytes: z.natural().default(DEFAULT_BUDGET_BYTES),
})

/** Retention policy with both optional fields resolved onto their defaults. */
interface RetentionPolicy {
  readonly maxRowBytes: number
  readonly budgetBytes: number
}

/**
 * Resolve the optional retention fields once, at construction, so every use
 * site reads the same policy instead of repeating a fallback.
 * @param config - the plugin config as loaded.
 * @returns the resolved per-row cap and resident budget.
 */
function resolveRetention(config: Config): RetentionPolicy {
  return {
    maxRowBytes: config.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES,
    budgetBytes: config.budgetBytes ?? DEFAULT_BUDGET_BYTES,
  }
}

/** Per-session write-behind bookkeeping (live sessions only; dropped at retire). */
interface DirtyState {
  /** Committed events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The persisted projection cache service. Opens the `session_projcache`
 * domain at init, checkpoints live sessions on a throttled write-behind
 * (count/interval triggers from {@link Config}) plus three mandatory points —
 * session creation, `turn/end`, and session disposal (the live-to-cold
 * moment) — and serves the
 * cached rows for a session header. Every durable write is fail-soft:
 * failures log a warning and the cache self-heals on the next write.
 */
export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessions']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, CheckpointRecord>
  private readonly dirty = new Map<Session, DirtyState>()
  /** Estimated resident bytes per cached row. */
  private readonly sizes = new Map<SessionId, number>()
  /** Last-touch order per cached row; higher is warmer. */
  private readonly touched = new Map<SessionId, number>()
  private readonly retention: RetentionPolicy
  private clock = 0

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
    this.retention = resolveRetention(config)
  }

  /** Open the domain, bring already-stored rows inside the budget, then install the write-behind listeners. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'sessionProjectionCache.domainClose')
    this.table = domain.table('sessions')
    await this.sweep()
    this.installWritePath()
  }

  /**
   * The stored record for one session, accepted only when its bound log
   * identity matches `expected`. A session id names a slot, not a lifecycle:
   * a recreated id or a persistence store swapped under a surviving cache
   * must not let an old record seed state folded from an unrelated log.
   * Synchronous from the domain's in-memory state — the same state every
   * write mutated, so a read can never go around the write chain to the
   * medium.
   * @param id - the session whose record is read.
   * @param expected - the log identity the caller holds (live or stored header).
   * @returns the identity-matching record, or `undefined` (absent or unrelated).
   */
  private recordFor(id: SessionId, expected: CheckpointIdentity): CheckpointRecord | undefined {
    const record = this.requireTable().get(id)
    if (record === undefined) return undefined
    return identityMatches(record.identity, expected) ? record : undefined
  }

  /**
   * The zero-I/O listing read: whole values viewed straight from the stored
   * rows (version-matching keys only), each cut carried with its watermark so
   * a client value store can seed under its higher-seq-wins rule — as stale
   * as the last durable checkpoint but never wrong, and never from an
   * unrelated log (the caller's header is the identity witness). Fresher
   * paths (the history tail baseline) supersede these values whenever a
   * session is actually opened.
   * @param meta - the listed session's header (identity witness; no log read).
   * @param keys - optional projection keys required by the caller's audience.
   * @returns the cut (`asOfSeq` = lowest served-row watermark), or
   *   `undefined` when no usable row exists for this lifecycle.
   */
  cachedSnapshot(
    meta: SessionHeader,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const record = this.recordFor(meta.id, identityOf(meta))
    if (record === undefined) return undefined
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows, keys)
    const servedKeys = Object.keys(values)
    if (servedKeys.length === 0) return undefined
    // The block carries ONE cut: the lowest served watermark is the seq every
    // value is at least current as of (under-claiming is safe under
    // higher-seq-wins; over-claiming would let a stale value outrank pushes).
    const asOfSeq = Math.min(...servedKeys.map(key => (record.rows[key] as { seq: number }).seq))
    return { asOfSeq, values }
  }

  /**
   * Hydrate projection cells for an already-prepared Session without another
   * persistence read. The cache seeds matching rows; the supplied exact log
   * advances every unit to the observation cut. No checkpoint is written
   * because the logical observation may contain recovery events not yet durable.
   * @param session - exact unpublished Session retained by persistence.
   * @param meta - observed lifecycle header.
   * @param events - exact logical event prefix represented by the observation.
   * @returns all projection values at the event cut.
   */
  hydratePrepared(
    session: Session,
    meta: SessionHeader,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot {
    const record = this.recordFor(meta.id, identityOf(meta))
    if (record === undefined) {
      return this.ctx.sessionProjections.hydrate(session, {}, events, 0)
    }
    try {
      return this.ctx.sessionProjections.hydrate(session, record.rows, events, 0)
    } catch {
      // Cached rows are disposable derived data. Retry from the exact log so a
      // stale schema cannot make a valid Session unreadable.
      return this.ctx.sessionProjections.hydrate(session, {}, events, 0)
    }
  }

  /**
   * Durably checkpoint one live session NOW (all mandatory points call
   * this; tests and carriers may too). The registry cut is snapshotted at
   * this boundary (states are live references), then the session's record is
   * replaced on the domain's write chain. NOT fail-soft — callers on the
   * fail-soft paths contain it.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability and event emission.
   */
  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    // Durability barrier: the checkpoint cut was taken above, so flushing
    // AFTER it guarantees every event inside the cut is durably logged
    // before the cache row lands — a crash can leave the cache behind the
    // log (longer tail replay) but never ahead of it (phantom values folded
    // from events no stored log contains). At detach the store entry is
    // already gone; persistence's own retirement drain covers that path and
    // any residual overreach is caught by the cold read's anchored floor.
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
    await this.put(session.id, identityOf(session.header), rows)
  }

  /**
   * Cold-read one session's projections from its complete log. Each unit is
   * seeded from the identity-checked cached rows — the registry skips `apply`
   * for the already-folded prefix (events at or below the row's `seq`) — and
   * the refreshed checkpoint is written back (fail-soft, fire-and-forget), so
   * the first cold read creates the cache row and later ones seed from it.
   * The caller supplies the complete log in seq order: this service never
   * consults the persistence layer.
   * @param meta - the stored session header (identity witness).
   * @param events - the session's complete log, in seq order.
   * @returns the projection cut at the log end.
   */
  coldSnapshot(meta: SessionHeader, events: readonly SessionEvent[]): ProjectionSnapshot {
    const restored = this.ctx.sessionProjections.restore(this.recordFor(meta.id, identityOf(meta))?.rows ?? {}, events, 0, meta)
    // Refresh the row so the next cold read seeds from it; fail-soft and
    // fire-and-forget — a failed write-back only costs a longer tail replay.
    void this.put(meta.id, identityOf(meta), restored.checkpoint).catch((error: unknown) => {
      this.ctx.logger.warn(`session projection cache: cold-read write-back for "${meta.id}" failed (cache stays stale): ${String(error)}`)
    })
    return restored.snapshot
  }

  /**
   * Discard one session's cached rows. The rows are derived from a log this
   * service never reads on its own, so deleting that log must delete them:
   * a surviving row is durable state with no session left to bind it to an
   * identity, and no later read can tell recreated from inherited.
   * @param id - the deleted session's id.
   * @returns whether a row existed.
   */
  async remove(id: SessionId): Promise<boolean> {
    this.forget(id)
    return await this.requireTable().delete(id)
  }


  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): void {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    // Creation is the FIRST mandatory point: a session that never talks (a
    // forked child seeded with its ancestor's title, say) would otherwise
    // get its first row only at detach — so a crash, or a fork held live in
    // the store, would leave the seed-derived values (the title) unreadable
    // on the cold list. The creation write captures the seed-derived cut.
    this.ctx.on('session/created', (session: Session) => {
      void this.flushSoft(session, 'create')
    })

    // Detach (the live-to-cold moment): the final mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // flushSoft's synchronous prefix reads and resets the dirty state, so
    // dropping it (timer already cleared by markClean) right after is safe.
    this.ctx.on('session/disposed', (session: Session) => {
      void this.flushSoft(session, 'detach')
      this.markClean(session)
      this.dirty.delete(session)
    })

    // With the plugin (their sessions outlive the cache): clear pending
    // timers and stop accepting new work. The domain-close effect registered
    // in init runs after this disposer and drains already-queued writes, so
    // a late flush can never land after disposal (it rejects `closed` into
    // flushSoft's warning instead).
    this.ctx.effect(() => () => {
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
    }, 'sessionProjectionCache.timers')
  }

  /**
   * One fail-soft durable checkpoint. Every caller has work by construction:
   * the throttle triggers only fire dirty (markClean clears the timer with
   * the counter) and the mandatory points write unconditionally.
   */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  /** Reset one session's dirty bookkeeping (its checkpoint is being written). */
  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /**
   * Replace one session's stored record with its log identity and `rows`.
   *
   * `rows` must already be detached from live unit state — the domain stores
   * the object itself, so a shared reference would let later folds mutate a
   * stored record. Both callers satisfy that: {@link write} passes the
   * registry's checkpoint (a structured clone) and {@link coldSnapshot}
   * passes a restore's freshly folded values.
   *
   * This therefore CHECKS the plain-JSON contract instead of re-cloning for
   * it. Detaching again here would be a second full copy of a value that a
   * turn-spanning projection can grow to tens of megabytes, allocated on
   * every throttled write.
   * @param id - the session whose record is replaced.
   * @param identity - the log identity the rows were folded from.
   * @param rows - the complete per-session checkpoint cut, already detached.
   * @throws TypeError when a unit state violates the plain-JSON contract.
   */
  private async put(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint): Promise<void> {
    if (!isJsonValue(rows)) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    const size = estimateRecordBytes(rows)
    if (this.retention.maxRowBytes > 0 && size > this.retention.maxRowBytes) {
      // Not a failure: the cache is a fold shortcut, so a row that costs more
      // resident memory than the tail replay it saves is simply not cached.
      this.ctx.logger.warn(
        `session projection cache: checkpoint for "${id}" is about ${size} bytes, above the `
        + `${this.retention.maxRowBytes}-byte row cap; not cached (the next cold read refolds the log)`,
      )
      await this.drop(id)
      return
    }
    await this.requireTable().put(id, { identity, rows: rows as CheckpointRecord['rows'] })
    this.sizes.set(id, size)
    this.touched.set(id, ++this.clock)
    await this.enforceBudget(id)
  }

  /**
   * Bring already-stored rows inside the policy at open: drop the ones above
   * the row cap, then hold the budget. Startup is the only moment an operator
   * can act on a cache that grew under an older policy, so the sweep is what
   * makes a lowered cap or budget take effect on the rows already on the
   * medium.
   */
  private async sweep(): Promise<void> {
    for (const [id, record] of [...this.requireTable().entries()]) {
      const size = estimateRecordBytes(record)
      if (this.retention.maxRowBytes > 0 && size > this.retention.maxRowBytes) {
        await this.drop(id)
        continue
      }
      this.sizes.set(id, size)
      this.touched.set(id, ++this.clock)
    }
    await this.enforceBudget()
  }

  /**
   * Drop the coldest rows until the resident total fits the budget.
   *
   * Two rows are never victims. One whose session is still attached: the next
   * checkpoint would immediately rewrite it, so evicting it trades a bounded
   * budget for write churn. And the row just written, which would otherwise be
   * deleted in the same breath as its write. With no other candidate the
   * budget stays soft — the alternative is evicting state a session is using.
   * @param spare - the row the caller just wrote, if any.
   */
  private async enforceBudget(spare?: SessionId): Promise<void> {
    const budget = this.retention.budgetBytes
    if (budget <= 0) return
    let resident = this.residentBytes()
    if (resident <= budget) return
    const coldest = [...this.sizes.keys()]
      .filter(id => id !== spare && this.ctx.sessions.get(id) === undefined)
      .sort((left, right) => (this.touched.get(left) ?? 0) - (this.touched.get(right) ?? 0))
    for (const id of coldest) {
      if (resident <= budget) return
      resident -= this.sizes.get(id) ?? 0
      await this.drop(id)
    }
  }

  /** Sum the tracked sizes of every cached row. */
  private residentBytes(): number {
    let total = 0
    for (const size of this.sizes.values()) total += size
    return total
  }

  /** Drop one session's cached row and its accounting. */
  private async drop(id: SessionId): Promise<void> {
    this.forget(id)
    await this.requireTable().delete(id)
  }

  /** Drop one session's accounting without touching the medium. */
  private forget(id: SessionId): void {
    this.sizes.delete(id)
    this.touched.delete(id)
  }

  private requireTable(): KvTable<SessionId, CheckpointRecord> {
    /* v8 ignore next -- Service.init assigns the table before the service becomes injectable */
    if (this.table === undefined) throw new Error('session projection cache is not initialized')
    return this.table
  }
}

/** Project a header onto the identity fields a record is bound to. */
function identityOf(header: SessionHeader): CheckpointIdentity {
  return { createdAt: header.createdAt, ...header.cwd === undefined ? {} : { cwd: header.cwd } }
}

/** Whether a stored record's bound identity names the caller's lifecycle. */
function identityMatches(stored: CheckpointIdentity, expected: CheckpointIdentity): boolean {
  return stored.createdAt === expected.createdAt && stored.cwd === expected.cwd
}

/** Bytes one JSON value contributes beyond its own payload. */
const VALUE_BYTES = 16

/**
 * Estimate the bytes one checkpoint record occupies once resident, without
 * serializing it.
 *
 * The figure only has to rank and bound rows, so it counts each value's own
 * payload — a string's UTF-8 length, plus a fixed per-value and per-key
 * overhead — and never allocates. Serializing instead would cost exactly the
 * multi-megabyte string this bound exists to avoid.
 * @param value - the checkpoint record to measure.
 * @returns an approximate resident byte count for the value.
 */
function estimateRecordBytes(value: unknown): number {
  if (typeof value === 'string') return VALUE_BYTES + Buffer.byteLength(value, 'utf8')
  if (value === null || typeof value !== 'object') return VALUE_BYTES
  if (Array.isArray(value)) {
    let total = VALUE_BYTES
    for (const entry of value) total += estimateRecordBytes(entry)
    return total
  }
  let total = VALUE_BYTES
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    total += VALUE_BYTES + Buffer.byteLength(key, 'utf8') + estimateRecordBytes(entry)
  }
  return total
}

export default SessionProjectionCache
