/**
 * Per-turn timing projection unit: a whole-log fold of each completed Turn's
 * wall time, first-token latency, and decode throughput, keyed by turn number.
 *
 * The client window fold (`deriveTurnMetrics` in `dsh-client-ui-chat`) reads
 * Turn locations and assistant Nodes the page actually loaded, so a turn whose
 * `turn/start` boundary is paged out discloses no wall time at all — while its
 * billed usage still arrives through the `turnUsage` unit. This unit folds the
 * complete durable log on the host instead, so a turn's timing is available
 * regardless of how much history the client has loaded.
 *
 * The fold state is incremental — one {@link StepTiming} entry per `step/start`,
 * advanced in place per event — and holds no raw events. That is a hard
 * requirement of this unit, not a micro-optimization: this state is
 * checkpointed to the projection cache, so an event-proportional state would
 * put a whole session's log in every checkpoint document. A turn can span an
 * entire session (one prompt, one long autonomous run), which is exactly the
 * shape that made the former raw-event buffer unbounded and O(n²).
 *
 * @module @deepseek-ai/dsh-session-stats/turn-timing
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { isTokenDelta } from './chunk-delta.ts'
import type { TurnTimingEntry, TurnTimingProjection } from './types.ts'

/** Fold state: finalized timing plus the open turn's incremental step fold. */
interface TurnTimingState {
  turns: Record<string, TurnTimingEntry>
  /** Turn number of the open turn; null between turns. */
  currentTurn: number | null
  /** The open turn's `turn/start` time; null between turns. */
  turnStart: number | null
  /** Closed steps in `step/start` order; each new step closes its predecessor. */
  steps: StepTiming[]
  /** The open step's boundary facts; null outside a step. */
  open: StepTiming | null
}

/** One step's boundary facts accumulated while folding a turn. */
interface StepTiming {
  step: number
  startTime: number
  firstTokenTime: number | null
  completedTime: number | null
  outputTokens: number | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    turnTiming: TurnTimingState
  }
}

const turnTimingEntrySchema: z.ZodType<TurnTimingEntry> = z.object({
  runMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative().optional(),
  tokensPerSecond: z.number().nonnegative().optional(),
  peakTokensPerSecond: z.number().nonnegative().optional(),
}).strict().transform(entry => ({
  runMs: entry.runMs,
  ...entry.ttftMs === undefined ? {} : { ttftMs: entry.ttftMs },
  ...entry.tokensPerSecond === undefined ? {} : { tokensPerSecond: entry.tokensPerSecond },
  ...entry.peakTokensPerSecond === undefined ? {} : { peakTokensPerSecond: entry.peakTokensPerSecond },
}))

const stepTimingSchema = z.object({
  step: z.number().int().nonnegative(),
  startTime: z.number().nonnegative(),
  firstTokenTime: z.number().nonnegative().nullable(),
  completedTime: z.number().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
}).strict()

const turnTimingStateSchema: z.ZodType<TurnTimingState> = z.object({
  turns: z.record(z.string(), turnTimingEntrySchema),
  currentTurn: z.number().int().nonnegative().nullable(),
  turnStart: z.number().nonnegative().nullable(),
  steps: z.array(stepTimingSchema),
  open: stepTimingSchema.nullable(),
}).strict().transform(({ turns, currentTurn, turnStart, steps, open }) => ({
  turns,
  currentTurn,
  turnStart,
  steps,
  open,
}))

const turnTimingViewSchema: z.ZodType<TurnTimingProjection> = z.object({
  turns: z.record(z.string(), turnTimingEntrySchema),
}).strict()

/**
 * Provider-reported completion tokens, guarded the way the window fold guards
 * node usage.
 * @param usage - the assistant/message event's optional usage record.
 * @returns the output-token count, or null when unreported or invalid.
 */
function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const value = (usage as { outputTokens?: unknown }).outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Fold one complete Turn's step facts into its timing entry.
 *
 * Wall time spans `turn/start` → `turn/end`. First-token latency is the turn's
 * lowest step's `step/start` → first token, and throughput divides summed
 * output tokens by summed decode wall time (first token → assembled message),
 * counting only steps that carry both; the peak is the highest such ratio over
 * a single step. An in-step retry keeps the step's recorded first token, the
 * same way the session fold and the window fold treat it.
 * @param turnStart - the turn's `turn/start` time.
 * @param turnEnd - the turn's `turn/end` time.
 * @param steps - every step opened during the turn, in `step/start` order.
 * @returns the turn's timing entry.
 */
function settleTurnTiming(turnStart: number, turnEnd: number, steps: readonly StepTiming[]): TurnTimingEntry {
  const entry: TurnTimingEntry = { runMs: Math.max(0, turnEnd - turnStart) }
  let lowest: StepTiming | undefined
  let decodeMs = 0
  let outputTokens = 0
  let sampled = false
  let peak: number | undefined
  for (const step of steps) {
    if (lowest === undefined || step.step < lowest.step) lowest = step
    if (step.firstTokenTime === null || step.completedTime === null || step.outputTokens === null) continue
    const decode = Math.max(0, step.completedTime - step.firstTokenTime)
    decodeMs += decode
    outputTokens += step.outputTokens
    sampled = true
    if (decode > 0) {
      const rate = step.outputTokens / (decode / 1000)
      peak = peak === undefined ? rate : Math.max(peak, rate)
    }
  }
  if (lowest !== undefined && lowest.firstTokenTime !== null) {
    entry.ttftMs = Math.max(0, lowest.firstTokenTime - lowest.startTime)
  }
  if (sampled && decodeMs > 0) entry.tokensPerSecond = outputTokens / (decodeMs / 1000)
  if (peak !== undefined) entry.peakTokensPerSecond = peak
  return entry
}

/**
 * Fold one complete Turn's durable events into its timing facts.
 *
 * This is the whole-log reference fold: it buffers the turn's steps and reads
 * the result in one pass, so tests can prove the incremental projection unit
 * stays equivalent to it. The projection unit itself folds per event and never
 * retains the events.
 * @param events - Turn-local durable events from `turn/start` through `turn/end`.
 * @returns the turn's timing, or undefined when its boundaries are missing.
 */
export function deriveTurnTiming(events: readonly SessionEvent[]): TurnTimingEntry | undefined {
  let turnStart: number | undefined
  let turnEnd: number | undefined
  const steps: StepTiming[] = []
  let open: StepTiming | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      turnStart = event.time
      continue
    }
    if (event.type === 'turn/end') {
      turnEnd = event.time
      continue
    }
    if (event.type === 'step/start') {
      open = {
        step: event.data.step,
        startTime: event.time,
        firstTokenTime: null,
        completedTime: null,
        outputTokens: null,
      }
      steps.push(open)
      continue
    }
    if (open === undefined) continue
    if (event.type === 'assistant/chunk') {
      if (open.firstTokenTime === null && isTokenDelta(event.data.chunk)) open.firstTokenTime = event.time
      continue
    }
    if (event.type === 'assistant/message') {
      open.completedTime = event.time
      open.outputTokens = usageOutputTokens(event.data.usage)
    }
  }
  if (turnStart === undefined || turnEnd === undefined) return undefined
  return settleTurnTiming(turnStart, turnEnd, steps)
}

/**
 * Session-stats' per-turn timing projection unit.
 *
 * A `turn/start` opens the turn, each `step/start` opens a step (closing the
 * previous one), `assistant/chunk` records the first token, and
 * `assistant/message` records the decode completion. At `turn/end` the step
 * facts fold into that turn's timing entry and the per-step state is dropped.
 * An event outside any turn leaves the state untouched, and a turn whose
 * boundaries never both land is absent from the map.
 */
export const turnTimingProjectionDefinition = {
  key: 'turnTiming',
  stateVersion: 2,
  stateSchema: turnTimingStateSchema,
  init: () => ({ turns: {}, currentTurn: null, turnStart: null, steps: [], open: null }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return { turns: state.turns, currentTurn: event.data.turn, turnStart: event.time, steps: [], open: null }
    }
    if (state.currentTurn === null) return state
    if (event.type === 'turn/end') {
      const turnStart = state.turnStart
      const timing = turnStart === null
        ? undefined
        : settleTurnTiming(turnStart, event.time, state.open === null ? state.steps : [...state.steps, state.open])
      return timing === undefined
        ? { turns: state.turns, currentTurn: null, turnStart: null, steps: [], open: null }
        : {
          turns: { ...state.turns, [String(state.currentTurn)]: timing },
          currentTurn: null,
          turnStart: null,
          steps: [],
          open: null,
        }
    }
    if (event.type === 'step/start') {
      const open: StepTiming = {
        step: event.data.step,
        startTime: event.time,
        firstTokenTime: null,
        completedTime: null,
        outputTokens: null,
      }
      return {
        turns: state.turns,
        currentTurn: state.currentTurn,
        turnStart: state.turnStart,
        steps: state.open === null ? state.steps : [...state.steps, state.open],
        open,
      }
    }
    const open = state.open
    if (open === null) return state
    if (event.type === 'assistant/chunk') {
      if (open.firstTokenTime !== null || !isTokenDelta(event.data.chunk)) return state
      return {
        turns: state.turns,
        currentTurn: state.currentTurn,
        turnStart: state.turnStart,
        steps: state.steps,
        open: { ...open, firstTokenTime: event.time },
      }
    }
    if (event.type === 'assistant/message') {
      return {
        turns: state.turns,
        currentTurn: state.currentTurn,
        turnStart: state.turnStart,
        steps: state.steps,
        open: { ...open, completedTime: event.time, outputTokens: usageOutputTokens(event.data.usage) },
      }
    }
    return state
  },
  wire: { viewSchema: turnTimingViewSchema, view: state => ({ turns: state.turns }) },
} satisfies ProjectionDefinition<'turnTiming', TurnTimingState>
