/**
 * Deleting a Session the Host still holds an Agent for, through the assembled
 * Session Controller rather than the command in isolation. Following a Session
 * activates its Agent in the background — that promotion is all that opening a
 * Session does — so the delete must retire that Agent before persistence will
 * discard the log. The factory here stands in for the agent loop's teardown:
 * disposal takes both the Agent and its Session back out of the stores.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentHandle, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionController from '../src/index.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'
import {
  createSessionTestController,
  testSessionPersistence,
  type TestSessionRemoteDefaults,
} from './test-remote.ts'

const defaults: TestSessionRemoteDefaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** One stored Session log. */
interface StoredLog {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface DeleteHarness {
  ctx: Context
  controller: SessionController
  /** Ids the persistence double discarded, in call order. */
  readonly removed: SessionId[]
  /** Ids the Workspace registry dropped, in call order. */
  readonly unregistered: SessionId[]
  /** `api-session/removed` broadcasts, in emission order. */
  readonly broadcast: SessionId[]
  /**
   * Follow one Session the way a Client opens it and wait for the background
   * promotion to attach its Agent.
   * @param sessionId - Session to open.
   * @returns the follow's cancellation.
   */
  open(sessionId: SessionId): Promise<AbortController>
}

/**
 * Mount the Session Controller over one stored log and a factory whose Agents
 * dispose the way the shipped loop's do.
 * @param logs - stored logs the persistence double reports.
 */
async function harness(logs: readonly StoredLog[]): Promise<DeleteHarness> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  installModelSelectionProjection(ctx)
  const byId = new Map(logs.map(log => [String(log.meta.id), log]))
  const removed: SessionId[] = []
  const unregistered: SessionId[] = []
  const broadcast: SessionId[] = []
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve(logs.map(log => log.meta)),
    inspect: (sessionId: SessionId) => {
      const log = byId.get(String(sessionId))
      return Promise.resolve(log === undefined ? undefined : { meta: log.meta, events: [...log.events] })
    },
    remove: (sessionId: SessionId) => {
      removed.push(sessionId)
      return Promise.resolve(byId.delete(String(sessionId)))
    },
  }) as never)
  ctx.provide('workspaceRegistry', {
    removeSession: (sessionId: SessionId) => {
      unregistered.push(sessionId)
      return Promise.resolve()
    },
  } as never)
  ctx.agents.setFactory(activatingFactory(ctx, byId))
  const controller = createSessionTestController(ctx, defaults)
  ctx.on('api-session/removed', (sessionId) => { broadcast.push(sessionId) })
  return {
    ctx,
    controller,
    removed,
    unregistered,
    broadcast,
    open: async (sessionId) => {
      const abort = new AbortController()
      const iterator = controller.follow(
        { address: { kind: 'session', sessionId } },
        abort.signal,
      )[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)
      // The promotion sits past the snapshot yield, so pull the generator
      // forward; it then resolves while the follower waits for events.
      void iterator.next()
      await vi.waitFor(() => { expect(ctx.agents.get(sessionId)).toBeDefined() })
      return abort
    },
  }
}

/**
 * Build a factory whose `resume` attaches a prepared Session and publishes an
 * idle Agent, exactly the lifecycle the agent loop owns in production. Only
 * the teardown matters here: disposing the handle reverses both registrations.
 * @param ctx - Host context carrying the stores.
 * @param logs - stored logs to attach from.
 */
function activatingFactory(ctx: Context, logs: ReadonlyMap<string, StoredLog>): AgentFactory {
  return {
    createAgent: () => Promise.reject(new Error('create is not exercised')),
    async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
      const stored = logs.get(String(options.resumeSessionId))
      if (stored === undefined) {
        throw new Error(`session "${String(options.resumeSessionId)}" is not stored`)
      }
      const session = ctx.sessions.prepare(options.resumeSessionId, {
        seed: [...stored.events],
        meta: stored.meta,
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

function log(id: string): StoredLog {
  return {
    meta: { version: 0, id: SessionId(id), createdAt: 1, cwd: '/workspace' },
    events: [],
  }
}

describe('Deleting an attached Session', () => {
  it('retires the idle Agent an open left behind and discards the log', async () => {
    const stored = log('attached-idle')
    const h = await harness([stored])
    const abort = await h.open(stored.meta.id)
    expect(h.ctx.sessions.get(stored.meta.id)).toBeDefined()

    await expect(h.controller.deleteSession({ sessionId: stored.meta.id })).resolves.toEqual({
      sessionId: stored.meta.id,
      deleted: true,
    })

    expect(h.removed).toEqual([stored.meta.id])
    expect(h.unregistered).toEqual([stored.meta.id])
    // Retiring the Agent publishes the removal through the sink a live
    // disposal uses; the delete then publishes its own commit.
    expect(h.broadcast).toEqual([stored.meta.id, stored.meta.id])
    expect(h.ctx.sessions.get(stored.meta.id)).toBeUndefined()
    expect(h.ctx.agents.get(stored.meta.id)).toBeUndefined()
    abort.abort()
  })

  it('refuses a Session whose Agent is mid-turn and leaves it attached', async () => {
    const stored = log('attached-running')
    const h = await harness([stored])
    const abort = await h.open(stored.meta.id)
    const agent = h.ctx.agents.get(stored.meta.id)
    if (agent === undefined) throw new Error('the promotion never attached an Agent')
    Object.assign(agent, { status: 'running' })

    await expect(h.controller.deleteSession({ sessionId: stored.meta.id })).rejects.toMatchObject({
      code: 'session/live',
      details: { sessionId: stored.meta.id },
    })

    expect(h.removed).toEqual([])
    expect(h.unregistered).toEqual([])
    expect(h.broadcast).toEqual([])
    expect(h.ctx.sessions.get(stored.meta.id)).toBeDefined()
    abort.abort()
  })
})
