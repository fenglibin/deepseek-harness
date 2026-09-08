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
  /** Anchor models the failover applies to; empty matches every anchor model. */
  when?: CandidateRoute[]
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
  when: z.array(candidateRouteSchema).default([]),
  candidates: z.array(candidateRouteSchema).default([]),
})

/** Stable identity for one provider/model route. */
function routeKey(route: CandidateRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Validate and detach a provider/model route list, rejecting duplicates and
 * blank ids. Programmatic callers can bypass Schemastery, so this re-judges the
 * bounds the schema would otherwise enforce.
 * @param routes - raw routes from the plugin config.
 * @param label - which pool is being resolved, for error messages.
 * @returns detached routes in declaration order.
 */
function resolveRoutes(routes: CandidateRoute[] | undefined, label: string): CandidateRoute[] {
  const seen = new Set<string>()
  const resolved: CandidateRoute[] = []
  for (const route of routes ?? []) {
    if (route.provider.length === 0 || route.model.length === 0) {
      throw new Error(`llm-failover: ${label} routes need non-empty provider and model ids`)
    }
    const key = routeKey(route)
    if (seen.has(key)) {
      throw new Error(`llm-failover: duplicate ${label} route "${route.provider}/${route.model}"`)
    }
    seen.add(key)
    resolved.push({ provider: route.provider, model: route.model })
  }
  return resolved
}

/** Resolve the configured candidate pool. */
function resolveCandidates(config: Config): CandidateRoute[] {
  return resolveRoutes(config.candidates, 'candidate')
}

/** Resolve the configured `when` filter; empty means unrestricted. */
function resolveWhen(config: Config): CandidateRoute[] {
  return resolveRoutes(config.when, 'when')
}

/**
 * Report whether an anchor route is admitted by the `when` filter. An empty
 * filter matches every route; otherwise the route must equal one listed entry.
 * @param when - resolved `when` routes (empty means unrestricted).
 * @param anchor - the session-selected route to test.
 * @returns true when the route is within the filter's scope.
 */
function matchesWhen(when: CandidateRoute[], anchor: CandidateRoute): boolean {
  if (when.length === 0) return true
  const key = routeKey(anchor)
  return when.some(entry => routeKey(entry) === key)
}

/** Per-agent failover state for the currently open step. */
interface FailoverState {
  /** Routes already attempted in the current step's rate-limit episode. */
  tried: Set<string>
  /** Route the next request should use, when a failover is pending. */
  pending: CandidateRoute | undefined
  /** Route the most recent request used. */
  current: CandidateRoute | undefined
  /** True when the step's anchor model is admitted by the `when` filter. */
  armed: boolean
}

/**
 * Install rate-limit failover across the configured candidate pool.
 * @param ctx - plugin context that owns the listeners and per-agent state.
 * @param config - validated candidate-pool configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const candidates = resolveCandidates(config)
  const when = resolveWhen(config)
  const states = new WeakMap<Agent, FailoverState>()

  const stateOf = (agent: Agent): FailoverState => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { tried: new Set(), pending: undefined, current: undefined, armed: false }
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
      const anchor: CandidateRoute = { provider: resolved.provider, model: resolved.model }
      state.current = anchor
      state.armed = matchesWhen(when, anchor)
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
    if (!state.armed) return next()
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
    state.armed = false
    return next()
  })
}
