/**
 * Provider-routed model-request retry policy on the agent loop's request
 * recovery extension point. Each scheduled retry is durable before its cancellable wait.
 *
 * @module @deepseek-ai/dsh-llm-retry
 */

import { randomUUID } from 'node:crypto'
import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { RATE_LIMIT_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { RetryId } from './brand.ts'
import type { LlmRetryEventData } from './types.ts'

export type { LlmRetryEventData, LlmRetryStartedEventData } from './types.ts'
export { RetryId } from './brand.ts'

export const name = 'llm-retry'
export const inject = ['agents', 'sessionProjections']

/** This policy executor has no config; providers own `retryPolicy`. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

function validateConfig(config: Config): void {
  const [key] = Object.keys(config)
  if (key === undefined) return
  if (key === 'retryPolicy') {
    throw new Error('llm-retry: retryPolicy belongs under each provider configuration')
  }
  throw new Error(`llm-retry: unknown key "${key}"`)
}

/** Non-serializable hooks used to make timing policy deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
}

type DownstreamOutcome =
  | { readonly type: 'decision'; readonly decision: RequestErrorAction }
  | { readonly type: 'error'; readonly error: unknown }

async function settleDownstream(
  next: () => Promise<RequestErrorAction>,
): Promise<DownstreamOutcome> {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error: unknown) {
    return { type: 'error', error }
  }
}

function localDelay(config: ResolvedRetryPolicy, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

/**
 * Wait before retrying a throttled request. A throttle names a quota window, so
 * the fixed rate-limit wait replaces the exponential delay that a shorter
 * failure would use; a provider instruction naming a longer window still wins.
 * `maxDelayMs` caps neither, because waiting less than the window repeats the
 * failure. Returns `undefined` when a provider instruction exceeds both bounds,
 * which leaves a bounded policy's decision to downstream recovery.
 * @param policy - resolved policy of the adapter route that served the failure.
 * @param providerDelay - validated provider `Retry-After`, when present.
 * @returns the delay to schedule, or `undefined` to decline the retry.
 */
function rateLimitDelay(policy: ResolvedRetryPolicy, providerDelay: number | undefined): number | undefined {
  if (providerDelay !== undefined && providerDelay > Math.max(policy.maxDelayMs, policy.rateLimitDelayMs)) {
    return policy.mode === 'normal' ? undefined : policy.rateLimitDelayMs
  }
  return Math.max(policy.rateLimitDelayMs, providerDelay ?? 0)
}

/**
 * Wait before retrying a failure that is not a throttle: a provider
 * `Retry-After` inside the cap verbatim, otherwise local exponential backoff.
 * Returns `undefined` for an over-cap instruction under a bounded policy.
 * @param policy - resolved policy of the adapter route that served the failure.
 * @param retry - one-based retry number this delay belongs to.
 * @param providerDelay - validated provider `Retry-After`, when present.
 * @param random - jitter sample source.
 * @returns the delay to schedule, or `undefined` to decline the retry.
 */
function standardDelay(
  policy: ResolvedRetryPolicy,
  retry: number,
  providerDelay: number | undefined,
  random: () => number,
): number | undefined {
  if (providerDelay === undefined) return localDelay(policy, retry, random)
  if (providerDelay <= policy.maxDelayMs) return providerDelay
  return policy.mode === 'normal' ? undefined : localDelay(policy, retry, random)
}

function retryPolicyKey(policy: ResolvedRetryPolicy): string {
  return policy.mode === 'always'
    ? JSON.stringify([
      policy.mode,
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
      policy.rateLimitDelayMs,
    ])
    : JSON.stringify([
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
      policy.rateLimitDelayMs,
    ])
}

function retryStateKey(provider: string, policyKey: string): string {
  return JSON.stringify([provider, policyKey])
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Install provider-routed normal or unbounded request recovery.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - empty executor config; provider registrations own policy.
 * @param internals - non-serializable deterministic hooks for tests.
 */
interface RetryStateEntry {
  retry: number
  retryId: RetryId
}

type LlmRetryState = Record<string, RetryStateEntry>

/** Whether this session has ever observed a provider rate-limit failure. */
interface LlmRateLimitState {
  tripped: boolean
}

// The cast bridges the branded retry id, which Zod cannot express directly.
const llmRetryStateSchema: zod.ZodType<LlmRetryState> = zod.record(zod.string(), zod.object({
  retry: zod.number().int().nonnegative(),
  retryId: zod.string(),
})) as unknown as zod.ZodType<LlmRetryState>

const llmRateLimitStateSchema = zod.object({ tripped: zod.boolean() })

/**
 * Session-wide latch over the log's rate-limit history. A retry records the
 * throttled failure it waits out; a throttled request that ended the turn
 * records it in the turn's terminal reason. Both are durable, so the latch
 * survives a cold resume with no live state.
 */
const llmRateLimitProjection = {
  key: 'llmRateLimit',
  stateVersion: 1,
  stateSchema: llmRateLimitStateSchema,
  init: () => ({ tripped: false }),
  apply: (state: LlmRateLimitState, event: SessionEvent): LlmRateLimitState => {
    if (state.tripped) return state
    if (event.type === 'llm/retry') {
      return event.data.failure.code === RATE_LIMIT_CODE ? { tripped: true } : state
    }
    if (event.type === 'turn/end') {
      const { reason } = event.data
      return reason.kind === 'error' && reason.error.code === RATE_LIMIT_CODE ? { tripped: true } : state
    }
    return state
  },
} satisfies ProjectionDefinition<'llmRateLimit', LlmRateLimitState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Retry state for the current step by provider and policy. */
    llmRetry: LlmRetryState
    /** Whether this session has already observed a provider rate-limit failure. */
    llmRateLimit: LlmRateLimitState
  }
}

/**
 * Report whether the session has already observed a provider rate-limit
 * failure. Consumers use it to stop work that would add concurrent model
 * requests to a route the provider is already throttling. The answer is
 * `false` in a composition without this plugin, which owns the fold.
 * @param ctx - context carrying the projection registry.
 * @param session - session whose durable log is folded.
 * @returns true once a rate-limit failure is in the log.
 */
export function isRateLimited(ctx: Context, session: Session): boolean {
  return ctx.sessionProjections.stateOf(session, 'llmRateLimit')?.tripped === true
}

export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  validateConfig(config)
  ctx.sessionProjections.register(llmRateLimitProjection)
  ctx.sessionProjections.register({
    key: 'llmRetry',
    stateVersion: 1,
    stateSchema: llmRetryStateSchema,
    init: () => ({}),
    apply: (state, event) => {
      if (event.type === 'step/start' || event.type === 'turn/end') return {}
      if (event.type !== 'llm/retry') return state
      const key = retryStateKey(event.data.provider, event.data.policyKey)
      const entry = state[key]
      if (entry?.retry === event.data.retry && entry.retryId === event.data.retryId) return state
      return { ...state, [key]: { retry: event.data.retry, retryId: event.data.retryId } }
    },
  })
  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function backoff(
    agent: Agent,
    turn: number,
    step: number,
    failure: LlmFailure,
    provider: string,
    policy: ResolvedRetryPolicy,
    policyKey: string,
    retry: number,
    retryId: RetryId,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return
    const eventData: LlmRetryEventData = policy.mode === 'normal'
      ? {
        retryId,
        turn,
        step,
        provider,
        mode: policy.mode,
        policyKey,
        retry,
        maxRetries: policy.maxRetries,
        delayMs,
        failure,
      }
      : {
        retryId,
        turn,
        step,
        provider,
        mode: policy.mode,
        policyKey,
        retry,
        delayMs,
        failure,
      }
    agent.session.append('llm/retry', eventData)
    if (!await cancellableDelay(delayMs, fusedSignal)) return
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  async function recover(
    { agent, turn, step, provider, failure, retryPolicy: policy, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    if (policy === undefined) return next()
    if (policy.mode === 'always') {
      if (signal.aborted || lifetime.signal.aborted) return
      const fusedSignal = AbortSignal.any([signal, lifetime.signal])
      // The loop and plugin lifetime stay open until delegated recovery settles.
      // An abort then wins before the decision or fallback can mutate later state.
      const downstream = await settleDownstream(next)
      if (fusedSignal.aborted) return
      if (downstream.type === 'error') {
        ctx.logger.warn(
          `llm-retry: provider "${provider}" always policy ignored a downstream recovery failure: %o`,
          downstream.error,
        )
      }
      if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') {
        return downstream.decision
      }
    } else if (!policy.retryableCodes.includes(failure.code)) {
      return next()
    }

    const policyKey = retryPolicyKey(policy)
    const retryState = ctx.sessionProjections.stateOf(agent.session, 'llmRetry') as LlmRetryState
    const previous = retryState[retryStateKey(provider, policyKey)]
    const previousRetry = previous?.retry ?? 0
    if (policy.mode === 'normal' && previousRetry >= policy.maxRetries) return next()
    const retry = previousRetry + 1
    const retryId = previous?.retryId ?? RetryId(randomUUID())
    const providerDelay = failure.providerRetryAfterMs !== undefined
      && Number.isFinite(failure.providerRetryAfterMs)
      && failure.providerRetryAfterMs > 0
      ? failure.providerRetryAfterMs
      : undefined
    const delayMs = failure.code === RATE_LIMIT_CODE
      ? rateLimitDelay(policy, providerDelay)
      : standardDelay(policy, retry, providerDelay, random)
    // A throttle the policy refuses to wait out is terminal for a bounded
    // policy: `next()` lets a downstream or default recovery decide.
    if (delayMs === undefined) return next()

    return backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal)
  }

  const disposeListener = ctx.on('agent/request-error', (
    payload,
    next: () => Promise<RequestErrorAction>,
  ) => {
    // A waterfall may have captured this callback before its registration was
    // removed. Lifetime cancellation must prevent that stale callback from
    // entering a downstream policy after disposal.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    return track(recover(payload, next))
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('llm-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'llm-retry: abort and drain active recovery')
}
