/**
 * Rate-limit failover across a configured candidate-model pool.
 *
 * When a model request fails with a throttle (`RATE_LIMIT`), this plugin
 * rewrites the route of the next retry to the first candidate it has not yet
 * tried this step, short-circuiting the provider retry policy's fixed
 * rate-limit wait. Only after every candidate has also been throttled does it
 * delegate to the downstream retry executor, which then applies the normal
 * wait-and-retry behavior.
 *
 * @module @deepseek-ai/dsh-llm-failover
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { RATE_LIMIT_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Stable Cordis plugin name. */
export const name = 'llm-failover'

/** One exact provider/model route a rate-limited request can fail over to. */
export interface CandidateRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/**
 * Plugin config. An empty candidate list disables failover: every rate-limit
 * failure then falls through to the provider's retry policy unchanged.
 */
export interface Config {
  /** Ordered failover routes, tried in order after a rate-limit failure. */
  candidates?: CandidateRoute[]
}

/** Schema for one failover route; both ids must be non-empty. */
const candidateRouteSchema: z<CandidateRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  candidates: z.array(candidateRouteSchema).default([]),
})

/** Stable identity for one provider/model route. */
function routeKey(route: CandidateRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Validate and detach the configured candidate pool, rejecting duplicates and
 * blank ids. Programmatic callers can bypass Schemastery, so this re-judges the
 * bounds the schema would otherwise enforce.
 * @param config - raw plugin config.
 * @returns detached candidate routes in declaration order.
 */
function resolveCandidates(config: Config): CandidateRoute[] {
  const seen = new Set<string>()
  const candidates: CandidateRoute[] = []
  for (const candidate of config.candidates ?? []) {
    if (candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('llm-failover: candidate routes need non-empty provider and model ids')
    }
    const key = routeKey(candidate)
    if (seen.has(key)) {
      throw new Error(`llm-failover: duplicate candidate route "${candidate.provider}/${candidate.model}"`)
    }
    seen.add(key)
    candidates.push({ provider: candidate.provider, model: candidate.model })
  }
  return candidates
}

/** Per-agent failover state for the currently open step. */
interface FailoverState {
  /** Routes already attempted in the current step's rate-limit episode. */
  tried: Set<string>
  /** Route the next request should use, when a failover is pending. */
  pending: CandidateRoute | undefined
  /** Route the most recent request used. */
  current: CandidateRoute | undefined
}

/**
 * Install rate-limit failover across the configured candidate pool.
 * @param ctx - plugin context that owns the listeners and per-agent state.
 * @param config - validated candidate-pool configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const candidates = resolveCandidates(config)
  const states = new WeakMap<Agent, FailoverState>()

  const stateOf = (agent: Agent): FailoverState => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { tried: new Set(), pending: undefined, current: undefined }
      states.set(agent, state)
    }
    return state
  }

  // Prepend keeps this outermost: model-selection and any later listener run
  // downstream, so a pending failover route is the last word on the request.
  ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const state = stateOf(payload.agent)
    const pending = state.pending
    if (pending === undefined) {
      state.current = { provider: resolved.provider, model: resolved.model }
      return resolved
    }
    state.pending = undefined
    state.current = pending
    // Record the candidate as tried at handoff, not only when it also
    // throttles: a candidate that then fails with a non-throttle error must
    // not be re-selected on a later throttle in the same step.
    state.tried.add(routeKey(pending))
    // A different model owns its own reasoning effort; clear the old route's
    // value so the candidate resolves its adapter default instead.
    const { reasoningEffort: _droppedEffort, ...rest } = resolved
    return { ...rest, provider: pending.provider, model: pending.model }
  }, { prepend: true })

  // Prepend runs this before the provider retry executor: an untried candidate
  // short-circuits with an immediate retry; otherwise the failure delegates to
  // the downstream policy and its fixed rate-limit wait.
  ctx.on('agent/request-error', (payload, next): Promise<RequestErrorAction> => {
    if (payload.failure.code !== RATE_LIMIT_CODE) return next()
    const state = stateOf(payload.agent)
    if (state.current !== undefined) {
      state.tried.add(routeKey(state.current))
    }
    const candidate = candidates.find(route => !state.tried.has(routeKey(route)))
    if (candidate === undefined) return next()
    state.pending = candidate
    return Promise.resolve({ kind: 'retry' })
  }, { prepend: true })

  // Each step is a fresh model-request series: clear the episode's history so a
  // later step can rotate through the same candidates again.
  ctx.on('agent/pre-step', (payload, next) => {
    const state = stateOf(payload.agent)
    state.tried.clear()
    state.pending = undefined
    return next()
  })
}
