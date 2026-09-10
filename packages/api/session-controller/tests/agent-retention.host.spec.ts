import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentHandle, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ApiSessionAgentController, type ApiSessionAgentRetention } from '../src/agent.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'
import { createSessionTestController, installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const roots: Context[] = []
const SELECTION = { provider: 'fixture', model: 'fixture-model' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface Activation {
  readonly agent: Agent
  readonly dispose: Mock<() => Promise<void>>
  readonly detach: () => void
}

interface Bench {
  readonly ctx: Context
  readonly agents: ApiSessionAgentController
  readonly cwd: string
  readonly activations: Map<string, Activation>
  advance(ms: number): void
  activate(id: string): Promise<Agent>
}

/** Controller-level bench: activations go through the create path with a real store and registry. */
async function bench(retention: ApiSessionAgentRetention): Promise<Bench> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  installModelSelectionProjection(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => SELECTION,
    saveSelection: () => Promise.resolve(),
  } as never)
  let clock = 1_000_000
  const agents = new ApiSessionAgentController(ctx, retention, { now: () => clock })
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-retention-'))
  const activations = new Map<string, Activation>()
  vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
    const meta: SessionHeader = { version: 0, id: options.sessionId, createdAt: 1, cwd }
    const session = ctx.sessions.create(options.sessionId, { meta })
    const agent = { id: options.sessionId, session, status: 'idle', ctx } as Agent
    const detach = ctx.agents.register(agent)
    const dispose = vi.fn(async () => { detach() })
    activations.set(options.sessionId, { agent, dispose, detach })
    return { agent, dispose }
  })
  return {
    ctx,
    agents,
    cwd,
    activations,
    advance: (ms: number) => { clock += ms },
    activate: (id: string) => agents.ensureSession(SessionId(id), cwd, false),
  }
}

/** The disposer a bench recorded for one activated Session. */
function disposal(benchmark: Bench, id: string): Activation['dispose'] {
  const activation = benchmark.activations.get(id)
  if (activation === undefined) throw new Error(`bench has no activation for "${id}"`)
  return activation.dispose
}

/** Re-state one bench Agent's lifecycle status, which is all the bound reads of it. */
function setStatus(benchmark: Bench, id: string, status: 'idle' | 'running'): void {
  const activation = benchmark.activations.get(id)
  if (activation === undefined) throw new Error(`bench has no activation for "${id}"`)
  ;(activation.agent as { status: string }).status = status
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('retained Agent bound', () => {
  it('retains every activation while the bound is not exceeded', async () => {
    const benchmark = await bench({ limit: 3, idleMs: 0 })
    await benchmark.activate('a')
    benchmark.advance(1)
    await benchmark.activate('b')
    benchmark.advance(1)
    await benchmark.activate('c')

    expect(benchmark.agents.retentionStats().agents).toBe(3)
    expect(disposal(benchmark, 'a')).not.toHaveBeenCalled()
    expect(disposal(benchmark, 'b')).not.toHaveBeenCalled()
    expect(disposal(benchmark, 'c')).not.toHaveBeenCalled()
    // No release happened, so no disposal may be reported as a retention decision.
    expect(benchmark.agents.consumeRetentionRelease(SessionId('a'))).toBe(false)
  })

  it('retains every activation when the bound is disabled', async () => {
    const benchmark = await bench({ limit: 0, idleMs: 0 })
    await benchmark.activate('a')
    benchmark.advance(1)
    await benchmark.activate('b')
    benchmark.advance(1)
    await benchmark.activate('c')

    expect(benchmark.agents.retentionStats().agents).toBe(3)
    expect(disposal(benchmark, 'a')).not.toHaveBeenCalled()
  })

  it('releases the least recently used idle Agent past the bound, exactly once', async () => {
    const benchmark = await bench({ limit: 2, idleMs: 60_000 })
    await benchmark.activate('first')
    benchmark.advance(1)
    await benchmark.activate('second')
    benchmark.advance(120_000)
    // Using the Session again makes it the most recent one, so 'second' is the LRU.
    benchmark.agents.touch(SessionId('first'))
    benchmark.advance(1)

    await benchmark.activate('third')

    expect(benchmark.agents.retentionStats().agents).toBe(2)
    expect(disposal(benchmark, 'second')).toHaveBeenCalledOnce()
    expect(disposal(benchmark, 'first')).not.toHaveBeenCalled()
    expect(disposal(benchmark, 'third')).not.toHaveBeenCalled()
    expect(benchmark.agents.consumeRetentionRelease(SessionId('second'))).toBe(true)
    // The report is consumed once: a later unrelated disposal must still publish.
    expect(benchmark.agents.consumeRetentionRelease(SessionId('second'))).toBe(false)
  })

  it('releases only once the quiet period has elapsed', async () => {
    const benchmark = await bench({ limit: 1, idleMs: 1000 })
    await benchmark.activate('quiet')
    benchmark.advance(999)

    await benchmark.activate('next')
    expect(benchmark.agents.retentionStats().agents).toBe(2)
    expect(disposal(benchmark, 'quiet')).not.toHaveBeenCalled()

    benchmark.advance(1)
    await benchmark.activate('third')
    expect(disposal(benchmark, 'quiet')).toHaveBeenCalledOnce()
    expect(disposal(benchmark, 'next')).not.toHaveBeenCalled()
  })

  it('never releases a running Agent, even as the least recently used', async () => {
    const benchmark = await bench({ limit: 1, idleMs: 0 })
    await benchmark.activate('busy')
    setStatus(benchmark, 'busy', 'running')
    benchmark.advance(1)

    // The bound is skipped rather than satisfied by an Agent mid-turn.
    await benchmark.activate('idle')
    expect(disposal(benchmark, 'busy')).not.toHaveBeenCalled()
    expect(benchmark.agents.retentionStats().agents).toBe(2)

    setStatus(benchmark, 'busy', 'idle')
    benchmark.advance(1)
    await benchmark.activate('later')
    // Now that it is quiescent the oldest first, and the drain continues until
    // the retained set fits again.
    expect(disposal(benchmark, 'busy')).toHaveBeenCalledOnce()
    expect(disposal(benchmark, 'idle')).toHaveBeenCalledOnce()
    expect(disposal(benchmark, 'later')).not.toHaveBeenCalled()
    expect(benchmark.agents.retentionStats().agents).toBe(1)
  })

  it('keeps an explicit release out of the retention decision', async () => {
    const benchmark = await bench({ limit: 2, idleMs: 0 })
    await benchmark.activate('explicit')

    await expect(benchmark.agents.release(SessionId('explicit'))).resolves.toBe(true)

    expect(disposal(benchmark, 'explicit')).toHaveBeenCalledOnce()
    expect(benchmark.agents.retentionStats().agents).toBe(0)
    // A deletion must still publish its removal: only the bound stays silent.
    expect(benchmark.agents.consumeRetentionRelease(SessionId('explicit'))).toBe(false)
  })

  it('accounts for the committed events of every retained Session', async () => {
    const benchmark = await bench({ limit: 0, idleMs: 0 })
    const first = await benchmark.activate('counted-a')
    benchmark.advance(1)
    const second = await benchmark.activate('counted-b')

    benchmark.agents.selectForNextRequest(first, SELECTION)
    benchmark.agents.selectForNextRequest(first, SELECTION)
    benchmark.agents.selectForNextRequest(second, SELECTION)

    expect(first.session.seq).toBe(2)
    expect(benchmark.agents.retentionStats()).toEqual({ agents: 2, events: 3 })
  })

  it('contains a failing release and still completes the activation that triggered it', async () => {
    const benchmark = await bench({ limit: 1, idleMs: 0 })
    const warn = vi.spyOn(benchmark.ctx.logger, 'warn').mockImplementation(() => {})
    await benchmark.activate('broken')
    disposal(benchmark, 'broken').mockImplementation(async () => {
      throw new Error('teardown refused')
    })
    benchmark.advance(1)

    await expect(benchmark.activate('next')).resolves.toBeDefined()

    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('releasing idle session "broken" failed')
    expect(message).toContain('teardown refused')
    expect(benchmark.agents.retentionStats().agents).toBe(1)
    expect(benchmark.agents.consumeRetentionRelease(SessionId('broken'))).toBe(false)
  })

  it('prunes a retained entry a later lifecycle replaced instead of disposing it', async () => {
    const benchmark = await bench({ limit: 1, idleMs: 0 })
    await benchmark.activate('handover')
    const stale = benchmark.activations.get('handover')
    if (stale === undefined) throw new Error('bench has no activation for "handover"')
    stale.detach()
    benchmark.ctx.agents.register({ ...stale.agent })
    benchmark.advance(1)

    await benchmark.activate('next')

    expect(stale.dispose).not.toHaveBeenCalled()
    expect(benchmark.agents.consumeRetentionRelease(SessionId('handover'))).toBe(false)
    expect(benchmark.agents.retentionStats().agents).toBe(1)
  })
})

interface OwnerBench {
  readonly ctx: Context
  readonly controller: ReturnType<typeof createSessionTestController>
  readonly headers: Map<string, SessionHeader>
}

/**
 * Build the factory the shipped loop stands for here. Only teardown matters:
 * disposing the handle reverses both registrations, so releasing an Agent
 * detaches its Session and emits `session/disposed`, exactly as production
 * does. A resume that only unregistered the Agent would let this bench pass
 * without ever exercising the removal the Host must not publish.
 * @param ctx - Host context carrying the stores.
 * @param logs - stored Session headers to attach from.
 * @returns a factory whose resume publishes an idle Agent over a prepared Session.
 */
function activatingFactory(ctx: Context, logs: ReadonlyMap<string, SessionHeader>): AgentFactory {
  return {
    createAgent: () => Promise.reject(new Error('create is not exercised')),
    async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
      const meta = logs.get(String(options.resumeSessionId))
      if (meta === undefined) {
        throw new Error(`session "${String(options.resumeSessionId)}" is not stored`)
      }
      const session = ctx.sessions.prepare(options.resumeSessionId, {
        seed: [],
        meta,
        seedSource: 'persistence',
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
      const detachSession = ctx.sessions.enter(session)
      const detachAgent = ctx.agents.enter(agent, ownerCtx.agent)
      try {
        const commit = await options.setup?.(ownerCtx.extend({ agent }))
        commit?.commit()
        ctx.sessions.announce(session)
        ctx.agents.announce(agent)
      } catch (error: unknown) {
        detachAgent()
        detachSession()
        throw error
      }
      return { agent, dispose: async () => {
        detachAgent()
        detachSession()
      } }
    },
  }
}

/** Host-level bench: the production controller over the real stores and lifecycle. */
async function ownerBench(liveAgentIdleMs: number): Promise<OwnerBench> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  installModelSelectionProjection(ctx)
  const headers = new Map<string, SessionHeader>()
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([...headers.values()]),
    inspect: (sessionId: SessionId) => {
      const meta = headers.get(String(sessionId))
      return Promise.resolve(meta === undefined ? undefined : { meta, events: [] })
    },
  }) as never)
  ctx.agents.setFactory(activatingFactory(ctx, headers))
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => SELECTION,
    cwd: '/tmp',
    liveAgentLimit: 1,
    liveAgentIdleMs,
    heapWatchIntervalMs: 0,
  })
  return { ctx, controller, headers }
}

function persisted(meta: OwnerBench['headers'], id: string): SessionId {
  const sessionId = SessionId(id)
  meta.set(id, { version: 0, id: sessionId, createdAt: 1, cwd: '/workspace' })
  return sessionId
}

describe('retention release at the Host boundary', () => {
  it('retires an idle Session past the bound without publishing a removal', async () => {
    const { ctx, controller, headers } = await ownerBench(0)
    const kept = persisted(headers, 'kept')
    const released = persisted(headers, 'released')
    const removed: SessionId[] = []
    ctx.on('api-session/removed', (sessionId) => { removed.push(sessionId) })
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})

    await expect(controller.resolveAgent(kept)).resolves.toMatchObject({ agent: { id: kept } })
    await expect(controller.resolveAgent(released)).resolves.toMatchObject({ agent: { id: released } })

    await vi.waitFor(() => { expect(ctx.agents.get(kept)).toBeUndefined() })
    await vi.waitFor(() => { expect(ctx.sessions.get(kept)).toBeUndefined() })
    expect(ctx.agents.get(released)).toBeDefined()
    // Released, not deleted: the Session left the store without its row leaving
    // the client's list, because only a deletion publishes a removal.
    expect(removed).toEqual([])
    expect(info.mock.calls.some(call => String(call[0]).includes('released idle session "kept"'))).toBe(true)

    // The Session is still durable: its next use takes the ordinary cold resume.
    await expect(controller.resolveAgent(kept)).resolves.toMatchObject({ agent: { id: kept } })
  })

  it('restarts the quiet period at a turn boundary', async () => {
    const { ctx, controller, headers } = await ownerBench(150)
    const kept = persisted(headers, 'kept')
    const other = persisted(headers, 'other')
    const third = persisted(headers, 'third')

    await expect(controller.resolveAgent(kept)).resolves.toMatchObject({ agent: { id: kept } })
    const live = ctx.agents.get(kept)
    expect(live).toBeDefined()
    await sleep(200)

    // The turn boundary is activity: the bound must measure the quiet period
    // from here, not from activation.
    ctx.emit('agent/status', { agent: live as Agent, status: 'idle' })
    await expect(controller.resolveAgent(other)).resolves.toMatchObject({ agent: { id: other } })
    expect(ctx.agents.get(kept)).toBeDefined()

    await sleep(200)
    await expect(controller.resolveAgent(third)).resolves.toMatchObject({ agent: { id: third } })
    await vi.waitFor(() => { expect(ctx.agents.get(kept)).toBeUndefined() })
  })
})
