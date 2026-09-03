/**
 * Session delete through the Host command controller: the running-turn
 * refusal, the retirement of an attached-but-idle Agent, the durable-log
 * discard, the projection-cache and Workspace registry cleanup the command
 * performs after it, and the removal broadcast that commits the delete.
 *
 * Every case mounts the command as ONE row among siblings, the way the shipped
 * compositions do — base's `session-persistence-*` row against web-app's
 * `session-controller` row, both inserted at the top level. `serviceRow`
 * provides each service from a fiber of its own, so the context proxy's
 * ancestor-only service walk cannot reach a sibling from the command's fiber.
 * `SessionController.static.inject` omits `sessionPersistence`, so the delete
 * reaches it only through `ctx.get`; a direct `ctx.sessionPersistence` read
 * throws "without inject" in production while still passing a bench that
 * calls `ctx.provide` on the command's own context.
 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { createSessionTestRemote } from './test-remote.ts'
import { describe, expect, it } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'

const header = (id: string): SessionHeader => ({
  version: 0,
  id: SessionId(id),
  createdAt: 1,
  cwd: '/workspace',
})

/** The Agent surface the delete path reaches: retiring one attached Session. */
interface DeleteAgents {
  /** Retire calls, in call order. */
  readonly released: SessionId[]
  /**
   * @param sessionId - Session identity whose Agent is retired.
   * @returns whether the Host released the Session.
   */
  release(sessionId: SessionId): Promise<boolean>
}

/**
 * The Agent half the delete path reaches. `releasable` names the ids the Host
 * activated itself — the rest keep an owner the command cannot retire — and
 * `failing` names the ids whose retirement rejects.
 * @param releasable - ids whose Agent the Host can retire.
 * @param failing - ids whose retirement rejects.
 */
function deleteAgents(releasable: readonly string[] = [], failing: readonly string[] = []): DeleteAgents {
  const released: SessionId[] = []
  const owned = new Set(releasable)
  const broken = new Set(failing)
  return {
    released,
    release: (sessionId: SessionId) => {
      released.push(sessionId)
      if (broken.has(String(sessionId))) return Promise.reject(new Error('teardown failed'))
      return Promise.resolve(owned.has(String(sessionId)))
    },
  }
}

/** One Host reference the command drops, or the broadcast that commits the delete. */
interface DeleteStep {
  readonly target: 'projections' | 'workspace' | 'broadcast'
  readonly sessionId: SessionId
}

/** The persistence surface the delete path uses. */
interface PersistenceDouble {
  readonly list: () => Promise<SessionHeader[]>
  readonly remove: (id: SessionId) => Promise<boolean>
}

/**
 * Map-backed persistence double. `list` reports exactly what is stored, so a
 * delete is observable as a listing change rather than a removal call count.
 * @param headers - stored headers.
 * @param remove - replacement for the default delete-by-id behavior.
 */
function memoryPersistence(
  headers: readonly SessionHeader[],
  remove?: (id: SessionId) => Promise<boolean>,
): PersistenceDouble {
  const stored = new Map(headers.map(meta => [meta.id, meta]))
  return {
    list: () => Promise.resolve([...stored.values()]),
    remove: remove ?? (id => Promise.resolve(stored.delete(id))),
  }
}

/**
 * One cordis.yml row: a service provided from a fiber of its own, which is
 * what makes every consumer of it a sibling rather than an ancestor.
 * @param name - provided service name.
 * @param value - service value.
 */
function serviceRow(name: string, value: object) {
  return { apply: (ctx: Context) => { ctx.provide(name, value as never) } }
}

interface DeleteBench {
  /** Root context; dispose it to unload every row. */
  ctx: Context
  /** The command row's own context — the fiber the command reads services through. */
  scope: Context
  controller: SessionCommandController
  /** The Agent half the command reached, recording every retirement it asked for. */
  agents: DeleteAgents
  /**
   * Every Host reference the command dropped and the broadcast it emitted, in
   * call order. The log discard precedes this trace, whose last step is the
   * broadcast — the delete is published only once every reference is gone.
   */
  readonly steps: readonly DeleteStep[]
  /** Ids an `api-session/removed` listener observed, in emission order. */
  readonly broadcast: readonly SessionId[]
  /** Ids the persistence double still reports. */
  stored(): Promise<string[]>
}

/** Host peers one delete bench varies: retirement outcomes and Agent status. */
interface BenchOptions {
  /** Ids whose Agent the Host activated and can retire. */
  readonly releasable?: readonly string[]
  /** Ids whose retirement rejects. */
  readonly failing?: readonly string[]
  /** Ids whose Agent is mid-turn. */
  readonly running?: readonly string[]
}

/**
 * Mount the command over sibling rows carrying replaceable Host peers.
 * @param persistence - the `sessionPersistence` double, or `undefined` for a
 *   deployment that mounts no persistence row at all.
 * @param evict - optional projection-cache `remove`; without it the deployment
 *   mounts no projection cache, which the command must tolerate.
 * @param options - Agent retirement outcomes and running-turn ids.
 */
async function bench(
  persistence: PersistenceDouble | undefined,
  evict?: (id: SessionId) => Promise<boolean>,
  options: BenchOptions = {},
): Promise<DeleteBench> {
  const ctx = new Context()
  const steps: DeleteStep[] = []
  const broadcast: SessionId[] = []
  const agents = deleteAgents(options.releasable, options.failing)
  ctx.on('api-session/removed', (sessionId) => {
    steps.push({ target: 'broadcast', sessionId })
    broadcast.push(sessionId)
  })
  await ctx.plugin(SessionStore)
  // The command reads the Agent registry to tell a running turn from an idle
  // attachment; only the ids in `running` report work in flight.
  const running = new Set(options.running ?? [])
  ctx.provide('agents', {
    get: (id: SessionId) => (running.has(String(id)) ? { status: 'running' } : undefined),
  } as never)
  if (persistence !== undefined) {
    await ctx.plugin(serviceRow('sessionPersistence', persistence))
  }
  if (evict !== undefined) {
    await ctx.plugin(serviceRow('sessionProjectionCache', {
      remove: (id: SessionId) => {
        steps.push({ target: 'projections', sessionId: id })
        return evict(id)
      },
    }))
  }
  await ctx.plugin(serviceRow('workspaceRegistry', {
    removeSession: (sessionId: SessionId) => {
      steps.push({ target: 'workspace', sessionId })
      return Promise.resolve()
    },
  }))
  // The command row declares exactly the services `SessionController.static
  // inject` declares of the ones the delete path reads, and nothing more:
  // `sessionPersistence` and `sessionProjectionCache` stay undeclared, so the
  // command can reach them only through `ctx.get`.
  let scope!: Context
  await ctx.plugin({
    inject: ['sessions', 'workspaceRegistry'],
    apply: (row: Context) => { scope = row },
  })
  return {
    ctx,
    scope,
    controller: new SessionCommandController(scope, agents as unknown as ApiSessionAgentController, '/default'),
    agents,
    steps,
    broadcast,
    stored: async () => (persistence === undefined ? [] : await persistence.list())
      .map(meta => String(meta.id)),
  }
}

describe('Session delete', () => {
  it('discards the durable log, cleans the registry, and broadcasts the id once', async () => {
    const kept = header('delete-kept')
    const doomed = header('delete-doomed')
    const b = await bench(memoryPersistence([kept, doomed]))

    await expect(b.controller.deleteSession({ sessionId: doomed.id })).resolves.toEqual({
      sessionId: doomed.id,
      deleted: true,
    })

    await expect(b.stored()).resolves.toEqual([String(kept.id)])
    expect(b.steps).toEqual([
      { target: 'workspace', sessionId: doomed.id },
      { target: 'broadcast', sessionId: doomed.id },
    ])
    expect(b.broadcast).toEqual([doomed.id])
    // A Session no Host Agent holds needs no retirement.
    expect(b.agents.released).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('retires an attached idle Agent before discarding the log', async () => {
    const kept = header('delete-idle-kept')
    const doomed = header('delete-idle-doomed')
    const b = await bench(memoryPersistence([kept, doomed]), undefined, {
      releasable: [String(doomed.id)],
    })
    b.scope.sessions.create(doomed.id, { meta: { cwd: '/workspace' } })

    await expect(b.controller.deleteSession({ sessionId: doomed.id })).resolves.toEqual({
      sessionId: doomed.id,
      deleted: true,
    })

    // Opening a Session attaches it without running anything, so the delete
    // retires the Agent instead of reporting the Session as live.
    expect(b.agents.released).toEqual([doomed.id])
    await expect(b.stored()).resolves.toEqual([String(kept.id)])
    expect(b.steps).toEqual([
      { target: 'workspace', sessionId: doomed.id },
      { target: 'broadcast', sessionId: doomed.id },
    ])
    expect(b.broadcast).toEqual([doomed.id])
    await b.ctx.fiber.dispose()
  })

  it('refuses a Session whose Agent is mid-turn, and never retires it', async () => {
    const persisted = header('delete-running')
    const b = await bench(memoryPersistence([persisted]), () => Promise.resolve(true), {
      running: [String(persisted.id)],
      releasable: [String(persisted.id)],
    })
    b.scope.sessions.create(persisted.id, { meta: { cwd: '/workspace' } })

    await expect(b.controller.deleteSession({ sessionId: persisted.id })).rejects.toMatchObject({
      code: 'session/live',
      details: { sessionId: persisted.id },
    })

    await expect(b.stored()).resolves.toEqual([String(persisted.id)])
    expect(b.steps).toEqual([])
    expect(b.broadcast).toEqual([])
    // A running turn is the user's to cancel: the delete must not tear it down.
    expect(b.agents.released).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('refuses an attached Session the Host cannot retire', async () => {
    const persisted = header('delete-unreleasable')
    const b = await bench(memoryPersistence([persisted]), () => Promise.resolve(true))
    b.scope.sessions.create(persisted.id, { meta: { cwd: '/workspace' } })

    await expect(b.controller.deleteSession({ sessionId: persisted.id })).rejects.toMatchObject({
      code: 'session/live',
      details: { sessionId: persisted.id },
    })

    await expect(b.stored()).resolves.toEqual([String(persisted.id)])
    expect(b.steps).toEqual([])
    expect(b.broadcast).toEqual([])
    // An Agent this controller did not activate keeps its own owner.
    expect(b.agents.released).toEqual([persisted.id])
    await b.ctx.fiber.dispose()
  })

  it('reports a retirement failure as an internal error without discarding the log', async () => {
    const persisted = header('delete-retire-failed')
    const b = await bench(memoryPersistence([persisted]), () => Promise.resolve(true), {
      failing: [String(persisted.id)],
    })
    b.scope.sessions.create(persisted.id, { meta: { cwd: '/workspace' } })

    await expect(b.controller.deleteSession({ sessionId: persisted.id })).rejects.toMatchObject({
      code: 'gateway/internal',
      message: expect.stringContaining(`failed to retire session "${String(persisted.id)}"`) as string,
    })

    await expect(b.stored()).resolves.toEqual([String(persisted.id)])
    expect(b.steps).toEqual([])
    expect(b.broadcast).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('drops the projection-cache row ahead of the registry cleanup, with or without a row', async () => {
    const cached = header('delete-cached')
    const withRow = await bench(memoryPersistence([cached]), () => Promise.resolve(true))

    await expect(withRow.controller.deleteSession({ sessionId: cached.id })).resolves.toEqual({
      sessionId: cached.id,
      deleted: true,
    })

    expect(withRow.steps).toEqual([
      { target: 'projections', sessionId: cached.id },
      { target: 'workspace', sessionId: cached.id },
      { target: 'broadcast', sessionId: cached.id },
    ])
    expect(withRow.broadcast).toEqual([cached.id])
    await withRow.ctx.fiber.dispose()

    // A cache holding no row for the id still completes: the miss is not a
    // reason to leave the registry reference behind.
    const uncached = header('delete-uncached')
    const withoutRow = await bench(memoryPersistence([uncached]), () => Promise.resolve(false))

    await expect(withoutRow.controller.deleteSession({ sessionId: uncached.id })).resolves.toEqual({
      sessionId: uncached.id,
      deleted: true,
    })

    expect(withoutRow.steps).toEqual([
      { target: 'projections', sessionId: uncached.id },
      { target: 'workspace', sessionId: uncached.id },
      { target: 'broadcast', sessionId: uncached.id },
    ])
    await withoutRow.ctx.fiber.dispose()
  })

  it('maps a persistence miss to session/not-found without cleaning up or broadcasting', async () => {
    const b = await bench({
      list: () => Promise.resolve([]),
      remove: (id: SessionId) => Promise.reject(new SessionPersistenceNotFoundError(id)),
    }, () => Promise.resolve(true))

    await expect(b.controller.deleteSession({ sessionId: SessionId('ghost') })).rejects.toMatchObject({
      code: 'session/not-found',
      details: { sessionId: 'ghost' },
    })

    expect(b.steps).toEqual([])
    expect(b.broadcast).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('maps any other persistence failure to an internal error', async () => {
    const b = await bench({
      list: () => Promise.resolve([]),
      remove: () => Promise.reject(new Error('storage offline')),
    }, () => Promise.resolve(true))

    await expect(b.controller.deleteSession({ sessionId: SessionId('unreadable') }))
      .rejects.toMatchObject({ code: 'gateway/internal' })

    expect(b.steps).toEqual([])
    expect(b.broadcast).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('refuses to delete when the deployment mounts no persistence row', async () => {
    const b = await bench(undefined, () => Promise.resolve(true))
    const doomed = header('delete-no-backend')

    await expect(b.controller.deleteSession({ sessionId: doomed.id })).rejects.toMatchObject({
      code: 'gateway/internal',
      message: 'deleting is unavailable: this deployment mounts no session-persistence service',
    })

    expect(b.steps).toEqual([])
    expect(b.broadcast).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('carries the delete over the generated Session Remote surface', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const doomed = header('delete-remote')
    const removed: SessionId[] = []
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([]),
      remove: (id: SessionId) => {
        removed.push(id)
        return Promise.resolve(true)
      },
    } as never)
    ctx.provide('workspaceRegistry', {
      removeSession: () => Promise.resolve(),
    } as never)
    // No Agent is registered, so the delete sees a cold Session.
    ctx.provide('agents', { get: () => undefined } as never)
    const remote = createSessionTestRemote(
      ctx,
      { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' },
    )

    await expect(remote.deleteSession({ sessionId: doomed.id })).resolves.toEqual({
      ok: true,
      value: { sessionId: doomed.id, deleted: true },
    })
    expect(removed).toEqual([doomed.id])
    await ctx.fiber.dispose()
  })
})
