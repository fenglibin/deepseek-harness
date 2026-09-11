/**
 * Periodic runtime watermark for a long-lived Host process.
 *
 * A Host that stays up for days retains work whose size is invisible from the
 * outside: one in-memory event log per attached Session, plus whatever the
 * deployment keeps live around them. When that total reaches V8's heap limit
 * the process dies on `FATAL ERROR: Ineffective mark-compacts near heap limit`,
 * and the abort leaves no evidence of what had grown. One sampled line per
 * interval turns that blind failure into a curve an operator can read, and the
 * optional near-limit snapshot turns it into a heap profile.
 *
 * @module @deepseek-ai/dsh-api-session-controller/heap-watch
 */

import { getHeapStatistics, setHeapSnapshotNearHeapLimit } from 'node:v8'
import type { Context } from '@deepseek-ai/cordis'

/** Retained work this Host could account for, as counted by its owner. */
export interface HeapWatchRetained {
  /** Ordinary Agents the Host keeps activated. */
  readonly agents: number
  /** Committed events those Agents' Sessions hold in memory. */
  readonly events: number
}

/** Resolved watermark policy for one Host process. */
export interface HeapWatchSpec {
  /** Sampling interval in milliseconds; `0` installs no watermark at all. */
  readonly intervalMs: number
  /**
   * Warn at or above this share of the V8 heap limit. The limit is the one
   * already in force (V8's default or `--max-old-space-size`), never raised
   * here: this watcher reports the ceiling the process will actually die on.
   */
  readonly warnRatio: number
  /**
   * Heap snapshots Node keeps when the process nears its heap limit; `0`
   * disables capture. A deployment choice with a cost worth stating: V8 builds
   * the snapshot graph synchronously on the main thread before streaming it,
   * so capture stops the process from serving for as long as the graph takes
   * to build and grows its footprint by multiples of the heap. At a
   * multi-gigabyte heap that is an unbounded stall — a crash with a FATAL
   * ERROR and a watermark curve becomes a hang with neither.
   */
  readonly snapshotNearLimit: number
  /** Retained-work counters read once per sample. */
  readonly retained: () => HeapWatchRetained
}

/** One sampled watermark. */
export interface HeapWatermark {
  /** Bytes V8 counts as live in the heap. */
  readonly heapUsedBytes: number
  /** Bytes V8 permits in the heap before it aborts the process. */
  readonly heapLimitBytes: number
  /** Resident set size of the process. */
  readonly rssBytes: number
  /** Ordinary Agents the Host keeps activated at sampling time. */
  readonly agents: number
  /** Committed events those Agents' Sessions hold in memory at sampling time. */
  readonly events: number
}

/** Default watermark interval for a Host process that stays up. */
export const DEFAULT_HEAP_WATCH_INTERVAL_MS = 5 * 60 * 1000

/**
 * Default share of the heap limit at which the watermark warns. Below it the
 * same numbers are reported at info: a curve is read from the normal samples,
 * and the warn sample is the one an operator must act on.
 */
export const DEFAULT_HEAP_WATCH_WARN_RATIO = 0.75

const MIB = 1024 * 1024

/**
 * Read one watermark from the running process.
 * @param retained - retained-work counters owned by the caller.
 * @returns heap, resident-set, and retained-work numbers of this process now.
 */
export function sampleHeapWatermark(retained: () => HeapWatchRetained): HeapWatermark {
  const heap = getHeapStatistics()
  const memory = process.memoryUsage()
  const counts = retained()
  return {
    heapUsedBytes: heap.used_heap_size,
    heapLimitBytes: heap.heap_size_limit,
    rssBytes: memory.rss,
    agents: counts.agents,
    events: counts.events,
  }
}

/**
 * Render one watermark as a single log line.
 * @param sample - the watermark to render.
 * @returns one line naming every sampled number, in whole mebibytes.
 */
export function describeHeapWatermark(sample: HeapWatermark): string {
  const used = Math.round(sample.heapUsedBytes / MIB)
  const limit = Math.round(sample.heapLimitBytes / MIB)
  const rss = Math.round(sample.rssBytes / MIB)
  const share = sample.heapLimitBytes <= 0
    ? 0
    : Math.round((sample.heapUsedBytes / sample.heapLimitBytes) * 100)
  return `session-controller heap watermark: heap ${used}MiB/${limit}MiB (${share}%), `
    + `rss ${rss}MiB, retained agents ${sample.agents}, retained events ${sample.events}`
}

/**
 * Test whether a watermark has reached the configured share of the heap limit.
 * @param sample - the watermark to judge.
 * @param warnRatio - share in the inclusive zero-to-one range.
 * @returns true when the used share is at or above `warnRatio`, and false when
 *   the process reports no heap limit to compare against.
 */
export function heapWatermarkExceeded(sample: HeapWatermark, warnRatio: number): boolean {
  if (sample.heapLimitBytes <= 0) return false
  return sample.heapUsedBytes / sample.heapLimitBytes >= warnRatio
}

/**
 * Install the periodic watermark, sampling once at installation so the
 * baseline is on record before any growth.
 * @param ctx - Host context whose fiber owns the interval.
 * @param spec - resolved watermark policy.
 * @throws when `intervalMs` is not a non-negative safe integer, when
 *   `warnRatio` leaves the inclusive zero-to-one range, or when
 *   `snapshotNearLimit` is not a non-negative safe integer.
 */
export function installHeapWatch(ctx: Context, spec: HeapWatchSpec): void {
  if (!Number.isSafeInteger(spec.intervalMs) || spec.intervalMs < 0) {
    throw new Error(`session-controller: heapWatchIntervalMs must be a non-negative safe integer (got ${String(spec.intervalMs)})`)
  }
  if (!(spec.warnRatio >= 0 && spec.warnRatio <= 1)) {
    throw new Error(`session-controller: heapWatchWarnRatio must be between 0 and 1 (got ${String(spec.warnRatio)})`)
  }
  if (!Number.isSafeInteger(spec.snapshotNearLimit) || spec.snapshotNearLimit < 0) {
    throw new Error(`session-controller: heapWatchSnapshotNearLimit must be a non-negative safe integer (got ${String(spec.snapshotNearLimit)})`)
  }
  // Omitted means disabled: an interval of zero is the deployment saying it
  // wants no watermark, so neither the timer nor the snapshot hook installs.
  if (spec.intervalMs === 0) return
  if (spec.snapshotNearLimit > 0) setHeapSnapshotNearHeapLimit(spec.snapshotNearLimit)
  const tick = (): void => {
    const sample = sampleHeapWatermark(spec.retained)
    const message = describeHeapWatermark(sample)
    if (heapWatermarkExceeded(sample, spec.warnRatio)) ctx.logger.warn(message)
    else ctx.logger.info(message)
  }
  tick()
  const timer = setInterval(tick, spec.intervalMs)
  // A diagnostic must never be the reason a process stays alive.
  timer.unref()
  ctx.effect(() => () => { clearInterval(timer) }, 'session-controller.heapWatch')
}
