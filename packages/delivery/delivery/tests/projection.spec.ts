/**
 * The `delivery` projection unit: the schema-validated state, the pure
 * `applyDeliveryProjection` fold's same-reference and failure retention, and
 * the client wire view. Mirrors the goal projection suite so the durable
 * delivery stream surfaces through the session tail and rejects host access
 * after a retained replay failure.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import DeliveryService, {
  DeliveryTaskId,
  applyDeliveryProjection,
  deliveryProjectionDefinition,
} from '@deepseek-ai/dsh-delivery'
import type {
  DeliveryProjection,
  DeliveryProjectionState,
  DeliverySnapshotChangeMeta,
} from '@deepseek-ai/dsh-delivery'

interface Bench {
  ctx: Context
  session: Session
  agent: Agent
  tailValues(): Record<string, unknown>
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    ctx: new Context(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

async function harness(withDelivery = true): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withDelivery) await ctx.plugin(DeliveryService)
  const session = ctx.sessions.create()
  const agent = stubAgent(session)
  ctx.agents.register(agent)
  return {
    ctx,
    session,
    agent,
    tailValues: () => ctx.sessionProjections.snapshot(session).values,
  }
}

const createMeta: DeliverySnapshotChangeMeta = {
  kind: 'delivery/change',
  version: 1,
  operation: 'create',
  task: { id: DeliveryTaskId('t1'), revision: 1, objective: 'x', phase: 'created', level: 'l0', changeCount: 0, designCount: 0, specCount: 0 },
  createdAt: 1,
  updatedAt: 1,
}

describe('delivery projection unit', () => {
  it('serves null before the first create and the whole task after', async () => {
    const bench = await harness()
    expect(bench.tailValues()).toEqual({ delivery: null })
    const created = bench.ctx.delivery.create(bench.agent, { objective: 'ship it' })
    expect(bench.tailValues().delivery).toMatchObject({
      task: { id: created.id, objective: 'ship it', phase: 'created' },
    })
  })

  it('validates the checkpoint state schema and rejects incoherent states', () => {
    const current: DeliveryProjection = {
      task: { id: DeliveryTaskId('t1'), revision: 1, objective: 'x', phase: 'created', level: 'l0', changeCount: 0, designCount: 0, specCount: 0 },
      createdAt: 1,
      updatedAt: 1,
    }
    const state: DeliveryProjectionState = { current, seenTaskIds: [current.task.id], failure: null }
    expect(deliveryProjectionDefinition.stateSchema.parse(state)).toEqual(state)
    // The current task id must be retained among the seen ids.
    expect(deliveryProjectionDefinition.stateSchema.safeParse({ ...state, seenTaskIds: [] }).success).toBe(false)
    // Seen ids must be unique.
    expect(deliveryProjectionDefinition.stateSchema.safeParse({
      ...state,
      seenTaskIds: [current.task.id, current.task.id],
    }).success).toBe(false)
    // The update cannot precede creation.
    expect(deliveryProjectionDefinition.stateSchema.safeParse({
      ...state,
      current: { ...current, createdAt: 2, updatedAt: 1 },
    }).success).toBe(false)
    const empty = deliveryProjectionDefinition.init()
    expect(deliveryProjectionDefinition.stateSchema.parse(empty)).toEqual(empty)
  })

  it('retains strict replay failures without throwing from the drive', () => {
    const current: DeliveryProjection = {
      task: { id: DeliveryTaskId('t1'), revision: 1, objective: 'x', phase: 'created', level: 'l0', changeCount: 0, designCount: 0, specCount: 0 },
      createdAt: 1,
      updatedAt: 1,
    }
    const state: DeliveryProjectionState = { current, seenTaskIds: [current.task.id], failure: null }
    const empty = deliveryProjectionDefinition.init()

    // An unrelated event returns the same reference.
    const turnStart = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never
    expect(applyDeliveryProjection(empty, turnStart)).toBe(empty)

    // A failed state is sticky and returns the same reference.
    const failed = { ...state, failure: 'already failed' }
    expect(applyDeliveryProjection(failed, turnStart)).toBe(failed)

    // A valid owned event advances the fold.
    const advanceMeta: DeliverySnapshotChangeMeta = {
      ...createMeta,
      operation: 'advance',
      task: { ...createMeta.task, revision: 2, phase: 'implemented' },
      createdAt: 1,
      updatedAt: 2,
    }
    const advance = { type: 'delivery/change', seq: 1, time: 2, data: advanceMeta } as never
    expect(applyDeliveryProjection(state, advance)).toEqual({
      ...state,
      current: { ...current, task: advanceMeta.task, updatedAt: 2 },
    })

    // A malformed owned event retains the failure instead of throwing.
    const malformed = {
      type: 'delivery/change', seq: 1, time: 2,
      data: { kind: 'delivery/change', version: 1, operation: 'create' },
    } as never
    expect(applyDeliveryProjection(state, malformed).failure)
      .toMatch(/delivery snapshot change must have exactly/)
  })

  it('fails host delivery access when the projection retained a replay failure', async () => {
    const bench = await harness()
    const failure = 'delivery replay failed at session event 0: invalid restored delivery stream'
    const state = bench.ctx.sessionProjections.stateOf(bench.session, 'delivery')
    expect(state).toBeDefined()
    Object.assign(state!, { failure })

    expect(() => bench.ctx.delivery.get(bench.agent)).toThrow(failure)
    expect(bench.tailValues().delivery).toBeNull()
  })

  it('has no delivery key when the delivery service is not composed', async () => {
    const bench = await harness(false)
    expect('delivery' in (bench.tailValues() ?? {})).toBe(false)
  })
})
