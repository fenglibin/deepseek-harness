import type { AssistantMessage, TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** One provider/model route that contributed a billed request attempt. */
export interface TurnTokenUsageRoute {
  readonly provider: string
  readonly model: string
}

/** Exact provider-reported token accounting for every attempt in one completed Turn. */
export interface TurnTokenUsage {
  /** Sum of uncached prompt input across all attempts. */
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  /** Exact aggregate prompt plus output total across all attempts. */
  readonly totalTokens: number
  /**
   * Sum of the bucket over the attempts that reported it; absent when none
   * did. An attempt that withholds the bucket contributes zero, so a Turn
   * mixing reporting and silent requests still discloses its cache traffic.
   */
  readonly cacheReadTokens?: number
  /** Sum of the bucket over the attempts that reported it, as for `cacheReadTokens`. */
  readonly cacheWriteTokens?: number
  /** Output subset, present only when every attempt reported it. */
  readonly reasoningTokens?: number
  /** Present only when every billed attempt has provider/model attribution. */
  readonly routes?: readonly TurnTokenUsageRoute[]
}

/** One billed attempt after normalization, as {@link TurnUsageFold} retains it. */
export interface NormalizedAttempt {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly route?: TurnTokenUsageRoute
}

/**
 * Attempt lifecycle position inside a turn. The machine is carried by
 * {@link TurnUsageFold} across events, so a step's boundary, its usage sample,
 * and its closure are read in the order the durable log recorded them.
 */
export type AttemptState =
  | { readonly kind: 'idle' }
  | {
    readonly kind: 'open'
    readonly turn: number
    readonly step: number
    readonly sample?: TokenUsage
  }
  | {
    readonly kind: 'finishClosed'
    readonly turn: number
    readonly step: number
  }
  | {
    readonly kind: 'settled'
    readonly turn: number
    readonly step: number
    readonly by: 'message' | 'retry'
  }

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeSum(values: readonly number[]): number | undefined {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

/**
 * Sum one optional bucket across the attempts that disclosed it.
 *
 * Billing buckets follow the harness `TokenUsage` convention an absent bucket
 * contributes zero, so the sum stays exact against `totalTokens` even when a
 * request stays silent. The bucket is withheld only when no attempt reported
 * it, which is what keeps a provider without that concept from disclosing a
 * fabricated zero row.
 * @param values - one entry per attempt, undefined where the attempt was silent.
 * @returns the disclosed sum, undefined when nothing was reported or the sum overflows.
 */
function sumDisclosed(values: readonly (number | undefined)[]): number | undefined {
  let sawValue = false
  const reported: number[] = []
  for (const value of values) {
    if (value === undefined) continue
    sawValue = true
    reported.push(value)
  }
  return sawValue ? safeSum(reported) : undefined
}

function messageRoute(message: AssistantMessage): TurnTokenUsageRoute | undefined {
  const { provider, model } = message.source
  return provider.length > 0 && model.length > 0 ? { provider, model } : undefined
}

function normalizeUsage(usage: TokenUsage, route?: TurnTokenUsageRoute): NormalizedAttempt | undefined {
  const {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
  } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  if (reasoningTokens !== undefined && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) {
    return undefined
  }

  // Absent cache buckets contribute zero: the harness `TokenUsage` convention
  // keeps `inputTokens` uncached and reports cache traffic in separate
  // optional buckets (the cumulative tokenUsage projection defaults them the
  // same way). A provider without a cache-write bucket (DeepSeek) therefore
  // still yields the exact prompt total as input + cacheRead + cacheWrite.
  const knownPrompt = safeSum([
    inputTokens,
    ...cacheReadTokens === undefined ? [] : [cacheReadTokens],
    ...cacheWriteTokens === undefined ? [] : [cacheWriteTokens],
  ])
  if (knownPrompt === undefined) return undefined

  let exactTotal: number
  if (totalTokens !== undefined) {
    if (!isCount(totalTokens)) return undefined
    const exactPrompt = totalTokens - outputTokens
    if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return undefined
    if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) {
      return undefined
    }
    exactTotal = totalTokens
  } else {
    const derivedTotal = safeSum([knownPrompt, outputTokens])
    if (derivedTotal === undefined) return undefined
    exactTotal = derivedTotal
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: exactTotal,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
    ...route === undefined ? {} : { route },
  }
}

function aggregateAttempts(attempts: readonly NormalizedAttempt[]): TurnTokenUsage | undefined {
  if (attempts.length === 0) return undefined
  const inputTokens = safeSum(attempts.map(attempt => attempt.inputTokens))
  const outputTokens = safeSum(attempts.map(attempt => attempt.outputTokens))
  const totalTokens = safeSum(attempts.map(attempt => attempt.totalTokens))
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined

  const cacheRead = attempts.map(attempt => attempt.cacheReadTokens)
  const cacheWrite = attempts.map(attempt => attempt.cacheWriteTokens)
  const reasoning = attempts.map(attempt => attempt.reasoningTokens)
  const cacheReadTokens = sumDisclosed(cacheRead)
  const cacheWriteTokens = sumDisclosed(cacheWrite)
  // Reasoning is an output subset with no "silent means zero" convention, so
  // it stays all-or-nothing: a partial sum would read as a real count.
  const reasoningTokens = reasoning.every(isCount) ? safeSum(reasoning) : undefined
  // A present cache bucket is bounded by exact prompt, and reasoning is bounded
  // by output. Safe required aggregates therefore imply safe optional sums.

  let routes: readonly TurnTokenUsageRoute[] | undefined
  const attributed = attempts.map(attempt => attempt.route)
  if (attributed.every((route): route is TurnTokenUsageRoute => route !== undefined)) {
    const unique = new Map<string, TurnTokenUsageRoute>()
    for (const route of attributed) unique.set(`${route.provider}\0${route.model}`, route)
    routes = [...unique.values()]
  }

  return {
    uncachedInputTokens: inputTokens,
    outputTokens,
    totalTokens,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
    ...routes === undefined ? {} : { routes },
  }
}

function sameAttempt(
  state: Exclude<AttemptState, { kind: 'idle' }>,
  turn: number,
  step: number,
): boolean {
  return state.turn === turn && state.step === step
}

/**
 * Normalize the open attempt's usage sample, or report that it cannot be
 * disclosed. Both failure modes — no sample at all, and a sample that is not
 * safe exact accounting — read the same to every caller: the attempt does not
 * join the turn.
 * @param attempt - the open attempt whose sample is closed.
 * @param route - provider/model attribution the closing event supplies, if any.
 * @returns the normalized attempt, or undefined when the attempt discloses nothing.
 */
function closeOpenAttempt(
  attempt: Extract<AttemptState, { kind: 'open' }>,
  route?: TurnTokenUsageRoute,
): NormalizedAttempt | undefined {
  return attempt.sample === undefined ? undefined : normalizeUsage(attempt.sample, route)
}

/**
 * In-flight fold of one Turn's attempt lifecycle.
 *
 * The fold holds the attempt state machine plus one normalized entry per
 * CLOSED attempt, so its size follows the turn's step count rather than its
 * event count. That is what lets the session projection persist it: a turn
 * spanning a whole session (one long autonomous run, tens of thousands of
 * events) folds to kilobytes, where retaining its raw events cost the log.
 */
export interface TurnUsageFold {
  /** Turn number this fold belongs to. */
  readonly turn: number
  /** Attempt lifecycle state inside the turn. */
  readonly attempt: AttemptState
  /** Closed attempts in event order, one entry per billed attempt. */
  readonly attempts: readonly NormalizedAttempt[]
  /** Whether the fold consumed the turn's `turn/end`. */
  readonly sawEnd: boolean
  /** Whether the fold saw a lifecycle violation and can no longer disclose. */
  readonly invalid: boolean
}

/**
 * Open a fold for one turn. The caller supplies the `turn/start` turn number
 * instead of feeding that event, because the fold exists only inside a turn.
 * @param turn - turn number the fold belongs to.
 * @returns the empty fold.
 */
export function beginTurnUsageFold(turn: number): TurnUsageFold {
  return { turn, attempt: { kind: 'idle' }, attempts: [], sawEnd: false, invalid: false }
}

/**
 * Fold one event into the turn's lifecycle.
 *
 * This is the single fold both readers share, so a turn's disclosure cannot
 * depend on how much of its log the caller holds. Violations latch: once
 * `invalid` is set the fold stays invalid and discloses nothing, which is what
 * makes the result independent of the remaining events.
 * @param fold - the fold covering every prior event of this turn.
 * @param event - the next committed session event.
 * @returns the next fold (the same reference when the event cannot change it).
 */
export function stepTurnUsageFold(fold: TurnUsageFold, event: SessionEvent): TurnUsageFold {
  if (fold.invalid) return fold
  const { turn } = fold
  if (event.type === 'turn/start') {
    // A second start inside one fold is the malformed turn the whole-log fold
    // rejects; a fold is created by its own turn/start.
    return { ...fold, invalid: true }
  }
  if (event.type === 'turn/end') {
    if (event.data.turn !== turn || fold.attempt.kind !== 'idle' || fold.sawEnd) {
      return { ...fold, invalid: true }
    }
    return { ...fold, sawEnd: true }
  }
  if (fold.sawEnd) return { ...fold, invalid: true }
  const attempt = fold.attempt
  if (event.type === 'step/start') {
    if (event.data.turn !== turn || attempt.kind !== 'idle') return { ...fold, invalid: true }
    return { ...fold, attempt: { kind: 'open', turn, step: event.data.step } }
  }
  if (event.type === 'llm/retry-started') {
    if (event.data.turn !== turn
      || attempt.kind !== 'settled'
      || attempt.by !== 'retry'
      || !sameAttempt(attempt, event.data.turn, event.data.step)) {
      return { ...fold, invalid: true }
    }
    return { ...fold, attempt: { kind: 'open', turn, step: event.data.step } }
  }
  if (event.type === 'assistant/chunk') {
    if (event.data.turn !== turn
      || attempt.kind !== 'open'
      || !sameAttempt(attempt, event.data.turn, event.data.step)) {
      return { ...fold, invalid: true }
    }
    if (event.data.chunk.type === 'usage') {
      return { ...fold, attempt: { ...attempt, sample: event.data.chunk.usage } }
    }
    if (event.data.chunk.type === 'finish'
      && (event.data.chunk.reason.kind === 'error' || event.data.chunk.reason.kind === 'aborted')) {
      // An error/aborted finish without a usage sample is an interrupted
      // attempt: skip it rather than discarding the turn's other attempts.
      let attempts = fold.attempts
      if (attempt.sample !== undefined) {
        const closed = closeOpenAttempt(attempt)
        if (closed === undefined) return { ...fold, invalid: true }
        attempts = [...attempts, closed]
      }
      return { ...fold, attempts, attempt: { kind: 'finishClosed', turn, step: event.data.step } }
    }
    return fold
  }
  if (event.type === 'assistant/message') {
    if (event.data.turn !== turn
      || attempt.kind !== 'open'
      || !sameAttempt(attempt, event.data.turn, event.data.step)) {
      return { ...fold, invalid: true }
    }
    const sampled = event.data.usage === undefined ? attempt : { ...attempt, sample: event.data.usage }
    const closed = closeOpenAttempt(sampled, messageRoute(event.data.message))
    if (closed === undefined) return { ...fold, invalid: true }
    return {
      ...fold,
      attempts: [...fold.attempts, closed],
      attempt: { kind: 'settled', turn, step: event.data.step, by: 'message' },
    }
  }
  if (event.type === 'llm/retry') {
    if (event.data.turn !== turn || attempt.kind === 'idle'
      || !sameAttempt(attempt, event.data.turn, event.data.step)) {
      return { ...fold, invalid: true }
    }
    if (attempt.kind === 'settled') return { ...fold, invalid: true }
    let attempts = fold.attempts
    if (attempt.kind === 'open' && attempt.sample !== undefined) {
      const closed = closeOpenAttempt(attempt)
      if (closed === undefined) return { ...fold, invalid: true }
      attempts = [...attempts, closed]
    }
    return { ...fold, attempts, attempt: { kind: 'settled', turn, step: event.data.step, by: 'retry' } }
  }
  if (event.type === 'step/end') {
    if (event.data.turn !== turn || attempt.kind === 'idle'
      || !sameAttempt(attempt, event.data.turn, event.data.step)) {
      return { ...fold, invalid: true }
    }
    // A sampled open attempt closes with its usage; an unsampled attempt was
    // interrupted before reporting usage and is skipped, not a disclosure failure.
    let attempts = fold.attempts
    if (attempt.kind === 'open' && attempt.sample !== undefined) {
      const closed = closeOpenAttempt(attempt)
      if (closed === undefined) return { ...fold, invalid: true }
      attempts = [...attempts, closed]
    }
    return { ...fold, attempts, attempt: { kind: 'idle' } }
  }
  return fold
}

/**
 * Read a finished fold's disclosure.
 * @param fold - the fold after every event of its turn was stepped.
 * @returns the exact aggregate, or undefined when the turn cannot disclose one.
 */
export function settleTurnUsageFold(fold: TurnUsageFold): TurnTokenUsage | undefined {
  return fold.invalid || !fold.sawEnd || fold.attempt.kind !== 'idle'
    ? undefined
    : aggregateAttempts(fold.attempts)
}

/**
 * Fold one complete Turn's durable attempt lifecycle into exact token accounting.
 *
 * No attempt is inferred from a usage sample. An attempt that reported a usage
 * sample must close with safe counts and an exact total; an attempt interrupted
 * before reporting any usage (aborted or failed stream) is skipped, so a turn's
 * remaining billed attempts still disclose. Missing lifecycle boundaries,
 * unsafe counts, and contradictory exact totals still make the whole disclosure
 * unavailable.
 *
 * A log whose first relevant event is not its `turn/start` is not a turn: the
 * window fold reads paged history, so a cut log is the normal case and reads as
 * unavailable rather than as a partial turn.
 * @param events - Turn-local durable events from `turn/start` through `turn/end`.
 * @returns exact aggregate usage, or undefined when it cannot be proven.
 */
export function deriveTurnTokenUsage(events: readonly SessionEvent[]): TurnTokenUsage | undefined {
  let fold: TurnUsageFold | undefined
  for (const event of events) {
    if (fold === undefined) {
      if (event.type !== 'turn/start') return undefined
      fold = beginTurnUsageFold(event.data.turn)
      continue
    }
    fold = stepTurnUsageFold(fold, event)
  }
  return fold === undefined ? undefined : settleTurnUsageFold(fold)
}
