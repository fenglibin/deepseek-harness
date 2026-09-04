/**
 * Per-turn token-usage projection unit: a whole-log fold of each completed
 * Turn's billed attempts into exact provider-reported accounting, keyed by
 * turn number.
 *
 * The client window fold (`deriveTurnTokenUsage` in `turn-tail.ts`) can only
 * fold the events a page actually loaded, so a turn whose `turn/start`
 * boundary is paged out (a long or mid-window cut) discloses nothing. This
 * unit folds the complete durable log on the host instead, so a turn's usage
 * is available regardless of how much history the client has loaded.
 *
 * @module @deepseek-ai/dsh-token-meter/turn-usage-projection
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnUsageProjection } from './projection.ts'
import { deriveTurnTokenUsage, type TurnTokenUsage } from './turn-usage.ts'

/** Fold state: finalized usage plus the in-flight turn's raw event buffer. */
interface TurnUsageState {
  turns: Record<string, TurnTokenUsage>
  /** Turn number of the open buffer; null between turns. */
  currentTurn: number | null
  /** Events from the open turn's `turn/start` through its `turn/end`. */
  buffer: SessionEvent[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    turnUsage: TurnUsageState
  }
}

const turnUsageRouteSchema = z.object({
  provider: z.string(),
  model: z.string(),
}).strict()

const turnTokenUsageSchema: z.ZodType<TurnTokenUsage> = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  routes: z.array(turnUsageRouteSchema).optional(),
}).strict().transform(usage => ({
  uncachedInputTokens: usage.uncachedInputTokens,
  outputTokens: usage.outputTokens,
  totalTokens: usage.totalTokens,
  ...usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
  ...usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens },
  ...usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens },
  ...usage.routes === undefined ? {} : { routes: usage.routes },
}))

const turnUsageStateSchema: z.ZodType<TurnUsageState> = z.object({
  turns: z.record(z.string(), turnTokenUsageSchema),
  currentTurn: z.number().int().nonnegative().nullable(),
  // Session events are already validated at append/restore; the buffer only
  // asserts array shape and trusts the elements.
  buffer: z.array(z.unknown()),
}).strict().transform(({ turns, currentTurn, buffer }) => ({
  turns,
  currentTurn,
  buffer: buffer as SessionEvent[],
}))

const turnUsageViewSchema: z.ZodType<TurnUsageProjection> = z.object({
  turns: z.record(z.string(), turnTokenUsageSchema),
}).strict()

/** Empty in-flight buffer fold (the persisted-cache precondition). */
function emptyBuffer(): SessionEvent[] {
  return []
}

/**
 * Token-meter's per-turn usage projection unit.
 *
 * The buffer carries every event between a turn's `turn/start` and `turn/end`;
 * at `turn/end` the buffered events fold through the existing
 * `deriveTurnTokenUsage` machine and a non-empty disclosure joins the map. An
 * event outside any turn leaves the state untouched, and a turn whose fold
 * discloses nothing (no billed attempt) is simply absent from the map.
 */
export const turnUsageProjectionDefinition = {
  key: 'turnUsage',
  stateVersion: 1,
  stateSchema: turnUsageStateSchema,
  init: () => ({ turns: {}, currentTurn: null, buffer: emptyBuffer() }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return { turns: state.turns, currentTurn: event.data.turn, buffer: [event] }
    }
    if (state.currentTurn === null) return state
    if (event.type === 'turn/end') {
      const usage = deriveTurnTokenUsage([...state.buffer, event])
      return usage === undefined
        ? { turns: state.turns, currentTurn: null, buffer: emptyBuffer() }
        : {
          turns: { ...state.turns, [String(state.currentTurn)]: usage },
          currentTurn: null,
          buffer: emptyBuffer(),
        }
    }
    return { ...state, buffer: [...state.buffer, event] }
  },
  wire: { viewSchema: turnUsageViewSchema, view: state => ({ turns: state.turns }) },
} satisfies ProjectionDefinition<'turnUsage', TurnUsageState>
