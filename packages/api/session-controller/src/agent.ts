/** Agent activation, composition, and model-selection policy owned by API Session. */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {
  Agent, AgentHandle, AgentOptions, AgentSetup, ModelSelection as AgentModelSelection,
  ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { ModelSelection } from './types.ts'

/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** Explicit-id creation attempted to adopt a Session under another preset. */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset and cannot be adopted under "${requestedPreset}"`
        : `session "${sessionId}" runs agent preset "${existingPreset}", not "${requestedPreset}"`,
    )
  }
}

/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'gateway/internal'>

/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

type InstalledSelection = ModelSelectionRef & {
  current: AgentModelSelection
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/**
 * Resolved policy for the ordinary Agents this Host keeps activated.
 *
 * A retained Agent pins its Session's whole in-memory event log, so an
 * unbounded retained set is an unbounded heap: a Host left up for days would
 * accumulate every Session a browser ever opened, each one holding one event
 * object per streamed delta, until V8 aborts the process on its heap limit.
 * Releases are therefore policy, not an emergency measure, and a released
 * Session stays durable and cold-resumable.
 */
export interface ApiSessionAgentRetention {
  /** Maximum retained ordinary Agents; `0` keeps every activation. */
  readonly limit: number
  /**
   * Quiet period before an idle retained Agent becomes eligible for release.
   * It protects the Sessions someone is working in from paying a cold resume
   * on their next prompt.
   */
  readonly idleMs: number
}

/** Non-serializable hooks used to make retention timing deterministic in tests. */
export interface ApiSessionAgentRetentionInternals {
  /** Clock returning the current epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Default number of ordinary Agents one Host keeps activated. */
export const DEFAULT_LIVE_AGENT_LIMIT = 16
/** Default quiet period before an idle retained Agent is eligible for release. */
export const DEFAULT_LIVE_AGENT_IDLE_MS = 10 * 60 * 1000

/** Retained work this controller can account for, reported to the runtime watermark. */
export interface ApiSessionAgentRetainedWork {
  /** Ordinary Agents currently retained. */
  readonly agents: number
  /** Committed events those Agents' Sessions hold in memory. */
  readonly events: number
}

/** One retained ordinary Agent and the last activity this controller observed for it. */
interface RetainedAgent {
  /** Teardown capability owed to the Session's owner. */
  readonly handle: AgentHandle
  /** Epoch milliseconds of the last observed use. */
  lastUsedAt: number
}

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param ctx - Host context carrying the Agent ownership registry.
 * @param session - attached or live Session whose ownership is tested.
 * @param agent - live Agent when one exists for the Session.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/**
 * Inspect one cold Session without repairing, resuming, or publishing it.
 * @param ctx - Host context carrying Session persistence.
 * @param sessionId - durable Session identity.
 * @param signal - optional cancellation for persistence reads.
 * @returns the persisted header and complete event prefix.
 */
export async function inspectApiSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    if (observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    return { meta: observation.header, events: [...observation.events] }
  } catch (error: unknown) {
    if (error instanceof SessionQueryError
      && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly creations = new Map<SessionId, Promise<Agent>>()
  /**
   * Teardown capability of every Agent this controller activated, keyed by
   * Session id, with the activity stamp the retention bound orders by.
   */
  private readonly retained = new Map<SessionId, RetainedAgent>()
  /**
   * IDs whose `session/disposed` must NOT be published as a removal. A
   * retention release leaves the durable Session in place, so a client told to
   * drop the row would lose a Session that still exists and can resume.
   */
  private readonly retentionReleases = new Set<SessionId>()
  /** In-flight retention releases; awaited by this controller's teardown. */
  private readonly releases = new Set<Promise<void>>()
  private readonly selections = new WeakMap<Agent, InstalledSelection>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()
  private readonly now: () => number

  /**
   * @param ctx - Host context carrying Agent, model, persistence, and Typert services.
   * @param retention - resolved retention policy for activated ordinary Agents.
   * @param internals - timing hooks; production callers pass none.
   */
  constructor(
    private readonly ctx: Context,
    private readonly retention: ApiSessionAgentRetention,
    internals: ApiSessionAgentRetentionInternals = {},
  ) {
    this.now = internals.now ?? Date.now
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.releases])
    }, 'api-session-agent.retentionReleases')
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation)
  }

  /**
   * Retire one ordinary Agent this controller activated, taking its Session out
   * of the Host store and draining whatever it still owes durable storage.
   * Discarding a Session's log needs this first: persistence refuses to delete
   * a log an attached Session could rewrite under the same id.
   *
   * An Agent this controller did not activate keeps its own owner — a
   * configured, subagent-owned, or externally created one is reported as not
   * released rather than disposed here.
   * @param sessionId - Session identity whose Agent is retired.
   * @returns whether the Host released the Session; false leaves it attached.
   */
  async release(sessionId: SessionId): Promise<boolean> {
    // An activation already in flight would re-enter the store right after the
    // dispose, so let it settle (or fail) before releasing what it produced.
    const inflight = this.resumes.get(sessionId) ?? this.creations.get(sessionId)
    if (inflight !== undefined) await inflight.then(() => undefined, () => undefined)
    const handle = this.retained.get(sessionId)?.handle
    if (handle === undefined) return false
    this.retained.delete(sessionId)
    // A different Agent under the same id belongs to a later lifecycle this
    // capability cannot tear down.
    if (this.ctx.agents.get(sessionId) !== handle.agent) return false
    await handle.dispose()
    return true
  }

  /**
   * Record one observed use of a Session, so the retention bound orders by real
   * activity rather than by activation order.
   * @param sessionId - Session whose retained Agent the caller just used.
   */
  touch(sessionId: SessionId): void {
    const entry = this.retained.get(sessionId)
    if (entry !== undefined) entry.lastUsedAt = this.now()
  }

  /**
   * Report whether one disposal is this controller's own retention release, so
   * the Host retires the Agent without publishing a removal.
   * @param sessionId - Session identity that just left the Host store.
   * @returns true for a retention release; the report is consumed once, and a
   *   deletion the Host published itself is never reported.
   */
  consumeRetentionRelease(sessionId: SessionId): boolean {
    return this.retentionReleases.delete(sessionId)
  }

  /**
   * Account for the work this controller keeps in memory, the retained-work
   * half of the Host's runtime watermark.
   * @returns the retained Agent count and their Sessions' committed-event
   *   count, read without copying any log.
   */
  retentionStats(): ApiSessionAgentRetainedWork {
    let events = 0
    for (const entry of this.retained.values()) events += entry.handle.agent.session.seq
    return { agents: this.retained.size, events }
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
  ): Promise<ApiSessionAgentResult> {
    this.touch(sessionId)
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      return { agent: await resume }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) return raced
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * Resolve one requested identity, creating or resuming it once.
   * @param sessionId - requested Session identity.
   * @param cwd - directory the Session must own.
   * @param checkPersistedIdentity - whether to inspect a cold identity before creation.
   * @param presetId - optional Agent preset the Session must own.
   * @returns the matching live ordinary Agent.
   */
  async ensureSession(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId?: string,
  ): Promise<Agent> {
    this.touch(sessionId)
    let creation = this.creations.get(sessionId)
    if (creation === undefined) {
      creation = this.createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId)
        .catch((error: unknown) => {
          const live = this.ctx.agents.get(sessionId)
          if (live !== undefined) {
            if (hasApiSessionSubagentOwner(this.ctx, live.session, live)) {
              throw new ApiSessionSubagentOwnership(sessionId)
            }
            return live
          }
          const attached = this.ctx.sessions.get(sessionId)
          if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
            throw new ApiSessionSubagentOwnership(sessionId)
          }
          throw error
        })
        .finally(() => { this.creations.delete(sessionId) })
      this.creations.set(sessionId, creation)
    }
    const agent = await creation
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (presetId !== undefined) {
      this.assertPresetUnchanged(sessionId, presetId, this.presetForSession(agent.session))
    }
    if (agent.session.header.cwd !== cwd) {
      throw new ApiSessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
    }
    return agent
  }

  /**
   * Install or return the Session-local model selection used by prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @returns the installed mutable selection reference.
   */
  selectionFor(agent: Agent): InstalledSelection {
    this.touch(agent.id)
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    if (projectionState === undefined) {
      throw new Error('api-session: required modelSelection projection is not registered')
    }
    let picked = projectionState.pending === null
      ? undefined
      : agentModelSelection(projectionState.pending)
    const sessionProjections = this.ctx.sessionProjections
    const defaultModel = this.ctx.agentDefaultModel
    const selection: InstalledSelection = {
      get current(): AgentModelSelection {
        if (picked !== undefined) return picked
        // The session's model, read live so a selection made after this Agent
        // resumed still resolves: the last authored choice, or the model
        // recorded by the first request header. A reroute (failover/round-robin)
        // never advances it, so a borrowed candidate cannot become the session's
        // model. With no authored choice and no request yet, the deployment
        // default is it.
        const chosen = sessionProjections.stateOf(agent.session, 'modelSelection')?.chosen ?? null
        if (chosen !== null) return agentModelSelection(chosen)
        return defaultModel.currentSelection()
      },
      set current(next: AgentModelSelection) {
        picked = next
      },
      consume(provider: string, model: string, reasoningEffort: string | undefined): boolean {
        if (picked?.provider !== provider
          || picked.model !== model
          || picked.reasoningEffort !== reasoningEffort) return false
        picked = undefined
        return true
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * Commit and cache one validated selection for the next prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @param selection - validated selection to record and apply.
   */
  selectForNextRequest(agent: Agent, selection: AgentModelSelection): void {
    agent.session.append('model/selection', selection)
    this.selectionFor(agent).current = selection
  }

  /**
   * Let a matching durable request header retire the execution cache.
   * @param agent - live Agent whose request was recorded.
   * @param provider - provider route used by the request.
   * @param model - provider-owned model used by the request.
   * @param reasoningEffort - adapter-owned effort used by the request.
   * @returns whether the pending selection was consumed.
   */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): boolean {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort) ?? false
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined
  }

  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    this.touch(agent.id)
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<{
    readonly agentPreset?: string
    readonly setup: AgentSetup
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { setup: (agentCtx) => { this.installSelection(agentCtx) } }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        this.installSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(sessionId: SessionId, supplied?: SessionObservation): Promise<Agent> {
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied)
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return await this.resumeObserved(sessionId, observation)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
  ): Promise<Agent> {
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    return this.activate(sessionId, await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    }))
  }

  /**
   * Record one activated Agent's teardown capability against its Session id,
   * then hold the retained set to its configured bound.
   * @param sessionId - Session identity the Agent was activated under.
   * @param handle - owned Agent plus its disposer.
   * @returns the activated Agent.
   */
  private activate(sessionId: SessionId, handle: AgentHandle): Agent {
    this.retained.set(sessionId, { handle, lastUsedAt: this.now() })
    this.enforceRetention()
    return handle.agent
  }

  /**
   * Release least-recently-used idle Agents until the retained set fits the
   * configured limit. A released Session stays durable and cold-resumable, so
   * this is the ordinary resume path rather than a special case.
   *
   * Nothing waits on a release: an activation must not be delayed by another
   * Session's teardown, and `release` deletes the retained entry synchronously,
   * so the next loop turn already sees the smaller set.
   */
  private enforceRetention(): void {
    const { limit, idleMs } = this.retention
    if (limit <= 0) return
    this.dropStaleEntries()
    if (this.retained.size <= limit) return
    const now = this.now()
    const idle = [...this.retained.entries()]
      .filter(([sessionId, entry]) => this.releasable(sessionId, entry, now, idleMs))
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
    for (const [sessionId] of idle) {
      if (this.retained.size <= limit) return
      this.evict(sessionId)
    }
  }

  /**
   * Drop retained entries whose Agent the registry no longer holds under that
   * id. A later lifecycle owns its own teardown, and counting the stale entry
   * here would release other Sessions to satisfy a bound it does not consume.
   */
  private dropStaleEntries(): void {
    for (const [sessionId, entry] of this.retained) {
      if (this.ctx.agents.get(sessionId) === entry.handle.agent) continue
      this.retained.delete(sessionId)
    }
  }

  /**
   * Whether one retained Agent may be released: quiescent, untouched for the
   * configured quiet period, still the entry this map holds, and not being
   * activated right now.
   * @param sessionId - Session identity to judge.
   * @param entry - the retained entry observed by the caller.
   * @param now - current epoch milliseconds.
   * @param idleMs - quiet period this deployment requires.
   * @returns true when releasing this Agent cannot interrupt work in progress.
   */
  private releasable(
    sessionId: SessionId,
    entry: RetainedAgent,
    now: number,
    idleMs: number,
  ): boolean {
    if (now - entry.lastUsedAt < idleMs) return false
    if (this.retained.get(sessionId) !== entry) return false
    if (this.resumes.has(sessionId) || this.creations.has(sessionId)) return false
    // A different Agent under the same id belongs to a later lifecycle this
    // capability cannot tear down; refusing here also keeps `release` from
    // deleting a retained entry it would decline to dispose.
    if (this.ctx.agents.get(sessionId) !== entry.handle.agent) return false
    return entry.handle.agent.status === 'idle'
  }

  /**
   * Release one idle Agent as a retention decision, tracked so teardown can
   * await it and contained so a failing release never fails the activation that
   * triggered it.
   * @param sessionId - Session identity to release.
   */
  private evict(sessionId: SessionId): void {
    this.retentionReleases.add(sessionId)
    const task = (async () => {
      try {
        if (!await this.release(sessionId)) {
          this.retentionReleases.delete(sessionId)
          return
        }
        const counts = this.retentionStats()
        this.ctx.logger.info(
          `session-controller: released idle session "${sessionId}" past the retained limit; `
          + `retained agents ${counts.agents}, retained events ${counts.events}`,
        )
      } catch (error: unknown) {
        this.retentionReleases.delete(sessionId)
        this.ctx.logger.warn(
          `session-controller: releasing idle session "${sessionId}" failed: ${errorChain(error)}`,
        )
      }
    })()
    this.releases.add(task)
    void task.finally(() => { this.releases.delete(task) })
  }

  private async createOrAdopt(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId: string | undefined,
  ): Promise<Agent> {
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) return live

    if (checkPersistedIdentity) {
      try {
        using observation = await this.ctx.sessionQuery.observeSession(sessionId)
        if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
          throw new ApiSessionSubagentOwnership(sessionId)
        }
        if (observation.header.cwd !== cwd) {
          throw new ApiSessionCwdConflict(sessionId, cwd, observation.header.cwd)
        }
        const storedPreset = this.presetForObservation(observation)
        this.assertPresetUnchanged(sessionId, presetId, storedPreset)
        const composition = await this.composeAgent(storedPreset)
        return this.activate(sessionId, await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
        }))
      } catch (error: unknown) {
        if (!(error instanceof SessionQueryError)
          || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
    }

    try {
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    const composition = await this.composeAgent(presetId)
    return this.activate(sessionId, await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
    }))
  }

  private agentOptions(): AgentOptions {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    return { provider, model }
  }

  private installSelection(agentCtx: Context): void {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('api-session: Agent setup has no scoped Agent')
    this.selectionFor(agent)
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }

  private assertPresetUnchanged(
    sessionId: SessionId,
    requested: string | undefined,
    existing: string | undefined,
  ): void {
    if (requested === undefined || requested === existing) return
    throw new ApiSessionPresetConflict(sessionId, requested, existing)
  }
}

function agentModelSelection(selection: ModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}
