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
 * The fold state is incremental — {@link stepTurnUsageFold} per event — and
 * holds one entry per CLOSED attempt rather than the turn's events. That is a
 * hard requirement of this unit, not a micro-optimization: this state is
 * checkpointed to the projection cache, so an event-proportional state would
 * put a whole session's log in every checkpoint document. A turn can span an
 * entire session (one prompt, one long autonomous run), which is exactly the
 * shape that made the raw-event buffer unbounded.
 *
 * @module @deepseek-ai/dsh-token-meter/turn-usage-projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  beginTurnUsageFold,
  settleTurnUsageFold,
  stepTurnUsageFold,
  type AttemptState,
  type NormalizedAttempt,
  type TurnUsageFold,
} from './turn-usage.ts'
import type { TurnUsageProjection } from './projection.ts'
import type { TurnTokenUsage } from './turn-usage.ts'

/** Fold state: finalized usage plus the open turn's incremental fold. */
interface TurnUsageState {
  turns: Record<string, TurnTokenUsage>
  /** The open turn's fold; null between turns. */
  open: TurnUsageFold | null
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

const turnUsageFoldSchema = z.object({
  turn: z.number().int().nonnegative(),
  // The fold is derived from session events that were already validated at
  // append/restore, so this schema asserts the shape it reads back and trusts
  // the two derived members, exactly as the former raw-event buffer did.
  attempt: z.unknown(),
  attempts: z.array(z.unknown()),
  sawEnd: z.boolean(),
  invalid: z.boolean(),
}).strict()

const turnUsageStateSchema: z.ZodType<TurnUsageState> = z.object({
  turns: z.record(z.string(), turnTokenUsageSchema),
  open: turnUsageFoldSchema.nullable(),
}).strict().transform(({ turns, open }) => ({
  turns,
  open: open === null ? null : {
    turn: open.turn,
    attempt: open.attempt as AttemptState,
    attempts: open.attempts as NormalizedAttempt[],
    sawEnd: open.sawEnd,
    invalid: open.invalid,
  },
}))

const turnUsageViewSchema: z.ZodType<TurnUsageProjection> = z.object({
  turns: z.record(z.string(), turnTokenUsageSchema),
}).strict()

/**
 * Token-meter's per-turn usage projection unit.
 *
 * A `turn/start` opens a fold, every following event steps it, and `turn/end`
 * settles it: a non-empty disclosure joins the map and the fold is dropped
 * either way. An event outside any turn leaves the state untouched, and a turn
 * whose fold discloses nothing (no billed attempt) is simply absent from the
 * map.
 */
export const turnUsageProjectionDefinition = {
  key: 'turnUsage',
  stateVersion: 2,
  stateSchema: turnUsageStateSchema,
  init: () => ({ turns: {}, open: null }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return { turns: state.turns, open: beginTurnUsageFold(event.data.turn) }
    }
    if (state.open === null) return state
    const open = stepTurnUsageFold(state.open, event)
    if (event.type !== 'turn/end') return { turns: state.turns, open }
    const usage = settleTurnUsageFold(open)
    return usage === undefined
      ? { turns: state.turns, open: null }
      : { turns: { ...state.turns, [String(open.turn)]: usage }, open: null }
  },
  wire: { viewSchema: turnUsageViewSchema, view: state => ({ turns: state.turns }) },
} satisfies ProjectionDefinition<'turnUsage', TurnUsageState>
