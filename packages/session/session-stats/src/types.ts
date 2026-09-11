/**
 * Pure types of the session-stats domain: the ONE home of the `sessionStats`
 * projection-key declaration, free of this package's host-side value imports
 * (cordis context, zod, the llm chunk predicate). Two namespace projections
 * serve it — `./types` for host consumers, `./client` for client aggregates —
 * with zero content duplication.
 *
 * @module @deepseek-ai/dsh-session-stats/types
 */

// Marks this file a module so the declaration below AUGMENTS the projection
// table instead of declaring an ambient module.
export {}

/**
 * Whole-log conversation figures, independent of how much history a client
 * has paged in. Counts and wall times all fold from the complete durable log;
 * every field is 0 until its first contributing event lands. Field names
 * mirror the client window fold so an assembly without this unit can fall
 * back to it wholesale.
 */
export interface SessionStatsProjection {
  /** Distinct turns carrying at least one closed step (`step/end`); rejected or empty turns are uncounted. */
  turns: number
  /** Closed steps (`step/end` events) — completed, failed, and cancelled steps alike. */
  steps: number
  /** Summed model wall time (`step/start` → `assistant/message`) over steps that assembled a message. */
  llmMs: number
  /** Summed tool wall time over `tool/call` → `tool/result` pairs matched by callId. */
  toolMs: number
  /** Summed first-token latency (`step/start` → first non-empty delta chunk) over `ttftSteps`. */
  ttftMs: number
  /** Steps carrying a recorded first token. */
  ttftSteps: number
  /** Summed decode wall time (first token → `assistant/message`) over steps that also report output tokens. */
  decodeMs: number
  /** Summed provider output tokens over the same decode-timed steps. */
  decodeTokens: number
}

/** One user-turn entry in the whole-log turn outline. */
export interface TurnOutlineEntry {
  /** Turn number, stable for navigation. */
  turn: number
  /** Bounded opening user prompt; '' when that prompt carried no text (images or attachments only). */
  prompt: string
}

/**
 * Whole-log list of turns that opened with a direct user prompt, oldest first.
 * The open turn is carried as soon as its opening prompt lands, ahead of its
 * `turn/end`, so a reader sees the message they just sent before the turn closes.
 */
export interface TurnOutlineProjection {
  turns: readonly TurnOutlineEntry[]
}

/**
 * One completed turn's timing and decode throughput, folded from the complete
 * durable log rather than from the events a client happens to have paged in.
 */
export interface TurnTimingEntry {
  /** `turn/start` → `turn/end` wall time, ms. */
  runMs: number
  /** Lowest step's `step/start` → first token, ms; absent when unrecorded. */
  ttftMs?: number
  /** Summed provider output tokens per second of decode over steps reporting both. */
  tokensPerSecond?: number
  /** Highest single-step decode throughput; equals `tokensPerSecond` on a one-step turn. */
  peakTokensPerSecond?: number
}

/**
 * Whole-log timing and decode throughput per turn, keyed by turn number. A turn
 * whose boundaries lie outside a client's loaded window still discloses here.
 */
export interface TurnTimingProjection {
  turns: Record<string, TurnTimingEntry>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole-log turn/step counts and wall times; see {@link SessionStatsProjection}. */
    sessionStats: SessionStatsProjection
    /** Whole-log user-turn outline (turn + prompt); see {@link TurnOutlineProjection}. */
    turnOutline: TurnOutlineProjection
    /** Whole-log per-turn timing and throughput; see {@link TurnTimingProjection}. */
    turnTiming: TurnTimingProjection
  }
}
