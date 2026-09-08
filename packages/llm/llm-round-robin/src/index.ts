/**
 * Round-robin model rotation across the session-selected model and a
 * configured candidate pool.
 *
 * Every step advances a per-agent cursor and routes the request to the next
 * model in the rotation `[session-selected model, ...candidates]`. Spreading
 * consecutive steps across several routes lowers the chance any single model
 * trips a provider rate limit, unlike {@link @deepseek-ai/dsh-llm-failover},
 * which only switches models after a throttle has already happened.
 *
 * @module @deepseek-ai/dsh-llm-round-robin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Stable Cordis plugin name. */
export const name = 'llm-round-robin'

/** One exact provider/model route the rotation can step through. */
export interface CandidateRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/**
 * Plugin config. The session-selected model always anchors the rotation; an
 * empty candidate list disables rotation, leaving the selection unchanged.
 */
export interface Config {
  /** Anchor models the rotation applies to; empty matches every anchor model. */
  when?: CandidateRoute[]
  /** Ordered rotation routes, stepped through after the anchor each step. */
  candidates?: CandidateRoute[]
}

/** Schema for one rotation route; both ids must be non-empty. */
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
      throw new Error(`llm-round-robin: ${label} routes need non-empty provider and model ids`)
    }
    const key = routeKey(route)
    if (seen.has(key)) {
      throw new Error(`llm-round-robin: duplicate ${label} route "${route.provider}/${route.model}"`)
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

/** Per-agent rotation state. */
interface RotationState {
  /**
   * Index into the assembled rotation pool for the current step. Initialized to
   * -1 so the first step selects index 0, the session-selected anchor.
   */
  cursor: number
}

/**
 * Install round-robin model rotation across the configured candidate pool.
 * @param ctx - plugin context that owns the listeners and per-agent state.
 * @param config - validated candidate-pool configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const candidates = resolveCandidates(config)
  const when = resolveWhen(config)
  if (candidates.length === 0) return

  const states = new WeakMap<Agent, RotationState>()

  const stateOf = (agent: Agent): RotationState => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { cursor: -1 }
      states.set(agent, state)
    }
    return state
  }

  // Advance the rotation once per proposed step. Retries within a step do not
  // re-enter `agent/pre-step`, so a request that retries keeps the model this
  // step already chose.
  ctx.on('agent/pre-step', (payload, next) => {
    stateOf(payload.agent).cursor += 1
    return next()
  })

  // Prepend keeps this outermost: model selection and any later listener run
  // downstream, so the rotated route is the last word on the request.
  ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const anchor: CandidateRoute = { provider: resolved.provider, model: resolved.model }
    if (!matchesWhen(when, anchor)) return resolved
    const anchorKey = routeKey(anchor)
    const pool = [anchor, ...candidates.filter(candidate => routeKey(candidate) !== anchorKey)]
    const chosen = pool[stateOf(payload.agent).cursor % pool.length]
    if (chosen === undefined || routeKey(chosen) === anchorKey) return resolved
    // A different model owns its own reasoning effort; clear the anchor's value
    // so the candidate resolves its adapter default instead.
    const { reasoningEffort: _droppedEffort, ...rest } = resolved
    return { ...rest, provider: chosen.provider, model: chosen.model }
  }, { prepend: true })
}
