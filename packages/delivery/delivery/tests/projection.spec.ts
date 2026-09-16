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
  DeliveryTaskItem,
  DeliveryTaskRef,
  DeliveryTasksView,
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
  task: { id: DeliveryTaskId('t1'), revision: 1, objective: 'x', phase: 'created', level: 'l0', changeCount: 0, designCount: 0, specCount: 0, analysisDone: false },
  createdAt: 1,
  updatedAt: 1,
}

describe('delivery projection unit', () => {
  it('serves null before the first create and the whole task after', async () => {
    const bench = await harness()
    expect(bench.tailValues()).toEqual({ delivery: null, 'delivery-tasks': null })
    const created = bench.ctx.delivery.create(bench.agent, { objective: 'ship it' })
    expect(bench.tailValues().delivery).toMatchObject({
      task: { id: created.id, objective: 'ship it', phase: 'created' },
    })
  })

  it('validates the checkpoint state schema and rejects incoherent states', () => {
    const current: DeliveryProjection = {
      task: { id: DeliveryTaskId('t1'), revision: 1, objective: 'x', phase: 'created', level: 'l0', changeCount: 0, designCount: 0, specCount: 0, analysisDone: false },
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
      task: { id: DeliveryTaskId('t1'), revision: 1, objective: 'x', phase: 'created', level: 'l0', changeCount: 0, designCount: 0, specCount: 0, analysisDone: false },
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

describe('delivery tasks projection', () => {
  /** Compose the service, create an l2 task, and return its compare-and-set ref. */
  async function benchWithTask(): Promise<{ bench: Bench; ref: DeliveryTaskRef }> {
    const bench = await harness()
    const created = bench.ctx.delivery.create(bench.agent, { objective: 'ship it', level: 'l2' })
    return { bench, ref: { id: created.id, revision: created.revision } }
  }

  /** Read the checklist projection value. */
  function tasksView(bench: Bench): DeliveryTasksView {
    return bench.tailValues()['delivery-tasks'] as DeliveryTasksView
  }

  it('serves null before the first checklist write', async () => {
    const { bench } = await benchWithTask()
    expect(bench.tailValues()['delivery-tasks']).toBeNull()
  })

  it('serves the recorded checklist with per-phase progress', async () => {
    const { bench, ref } = await benchWithTask()
    bench.ctx.delivery.recordTasks(bench.agent, ref, 'add-thing', [
      { content: 'design the thing', phase: 'designed', status: 'completed' },
      { content: 'build the thing', phase: 'implemented', status: 'pending' },
      { content: 'verify the thing', phase: 'verified', status: 'pending' },
    ])
    const view = tasksView(bench)
    expect(view.changeId).toBe('add-thing')
    expect(view.items).toHaveLength(3)
    expect(view.progress.designed).toEqual({ done: 1, total: 1 })
    expect(view.progress.implemented).toEqual({ done: 0, total: 1 })
    expect(view.progress.created).toEqual({ done: 0, total: 0 })
  })

  it('counts only completed items, ignoring in_progress', async () => {
    const { bench, ref } = await benchWithTask()
    bench.ctx.delivery.recordTasks(bench.agent, ref, 'add-thing', [
      { content: 'a', phase: 'implemented', status: 'pending' },
      { content: 'b', phase: 'implemented', status: 'in_progress' },
      { content: 'c', phase: 'implemented', status: 'completed' },
    ])
    expect(tasksView(bench).progress.implemented).toEqual({ done: 1, total: 3 })
  })

  it('replaces the checklist on a later write', async () => {
    const { bench, ref } = await benchWithTask()
    bench.ctx.delivery.recordTasks(bench.agent, ref, 'add-thing', [
      { content: 'a', phase: 'implemented', status: 'pending' },
    ])
    bench.ctx.delivery.recordTasks(bench.agent, ref, 'add-thing', [
      { content: 'a', phase: 'implemented', status: 'completed' },
    ])
    expect(tasksView(bench).progress.implemented).toEqual({ done: 1, total: 1 })
  })

  it('rejects a checklist with duplicate content', async () => {
    const { bench, ref } = await benchWithTask()
    expect(() => {
      bench.ctx.delivery.recordTasks(bench.agent, ref, 'add-thing', [
        { content: 'same', phase: 'implemented', status: 'pending' },
        { content: 'same', phase: 'implemented', status: 'completed' },
      ])
    }).toThrow(/unique/)
  })

  it('rejects an item whose phase is not a lifecycle phase', async () => {
    const { bench, ref } = await benchWithTask()
    expect(() => {
      bench.ctx.delivery.recordTasks(
        bench.agent,
        ref,
        'add-thing',
        [{ content: 'x', phase: 'nonsense', status: 'pending' }] as unknown as DeliveryTaskItem[],
      )
    }).toThrow(/phase/)
  })
})

describe('delivery tasks mirror an l1 todo list', () => {
  /**
   * Compose the whole stack and create a task at one level.
   *
   * This bench attaches its session through `SessionStore`, which is what makes
   * the append reentrancy guard live. A hand-built `Session.create()` leaves
   * the store's attachment map empty, so an append attempted from inside a
   * `session/event` listener would silently succeed here and fail in
   * production.
   */
  async function mirrorBench(level: 'l0' | 'l1' | 'l2'): Promise<Bench> {
    const bench = await harness()
    bench.ctx.delivery.create(bench.agent, { objective: 'mirror it', level })
    return bench
  }

  /** Read the checklist projection value. */
  function view(bench: Bench): DeliveryTasksView | null {
    return bench.tailValues()['delivery-tasks'] as DeliveryTasksView | null
  }


  it('mirrors a todo list written by an l1 task without appending an event', async () => {
    const bench = await mirrorBench('l1')
    const before = bench.session.events.length
    bench.session.append('todo/write', { todos: [
      { content: 'first step', status: 'pending' },
      { content: 'second step', status: 'in_progress' },
    ] })
    const mirrored = view(bench)
    expect(mirrored?.source).toBe('mirrored')
    expect(mirrored?.items.map(item => item.content)).toEqual(['first step', 'second step'])
    expect(mirrored?.items.every(item => item.phase === 'implemented')).toBe(true)
    expect(mirrored?.progress.implemented).toEqual({ done: 0, total: 2 })
    // One event in, one event out: the mirror writes nothing, which is what
    // keeps it clear of the append reentrancy guard.
    expect(bench.session.events.length).toBe(before + 1)
  })

  it('replaces the mirrored checklist wholesale on each write', async () => {
    const bench = await mirrorBench('l1')
    bench.session.append('todo/write', { todos: [{ content: 'old', status: 'pending' }] })
    bench.session.append('todo/write', { todos: [{ content: 'new', status: 'completed' }] })
    const mirrored = view(bench)
    expect(mirrored?.items.map(item => item.content)).toEqual(['new'])
    expect(mirrored?.progress.implemented).toEqual({ done: 1, total: 1 })
  })

  it('does not mirror a todo list for an l0 task', async () => {
    const bench = await mirrorBench('l0')
    bench.session.append('todo/write', { todos: [{ content: 'ignored', status: 'pending' }] })
    expect(view(bench)).toBeNull()
  })

  it('does not mirror a todo list for an l2 task', async () => {
    const bench = await mirrorBench('l2')
    bench.session.append('todo/write', { todos: [{ content: 'ignored', status: 'pending' }] })
    expect(view(bench)).toBeNull()
  })

  it('keeps a recorded l2 checklist instead of overwriting it with a todo list', async () => {
    const bench = await mirrorBench('l2')
    const task = bench.ctx.delivery.get(bench.agent)
    bench.ctx.delivery.recordTasks(
      bench.agent,
      { id: task!.id, revision: task!.revision },
      'add-thing',
      [{ content: 'recorded step', phase: 'implemented', status: 'pending' }],
    )
    bench.session.append('todo/write', { todos: [{ content: 'todo step', status: 'completed' }] })
    const kept = view(bench)
    expect(kept?.source).toBe('recorded')
    expect(kept?.changeId).toBe('add-thing')
    expect(kept?.items.map(item => item.content)).toEqual(['recorded step'])
  })

  it('places a mirrored item in the task current phase', async () => {
    const bench = await mirrorBench('l1')
    const created = bench.ctx.delivery.get(bench.agent)!
    let ref: DeliveryTaskRef = { id: created.id, revision: created.revision }
    bench.ctx.delivery.markAnalyzed(bench.agent, ref)
    ref = { id: created.id, revision: created.revision + 1 }
    bench.ctx.delivery.recordDesign(bench.agent, ref, 'the design')
    ref = { id: created.id, revision: created.revision + 2 }
    bench.ctx.delivery.advance(bench.agent, ref, 'designed')
    bench.session.append('todo/write', { todos: [{ content: 'designed step', status: 'pending' }] })
    expect(view(bench)?.items[0]?.phase).toBe('implemented')
  })

  it('drops the mirror when the task is cleared', async () => {
    const bench = await mirrorBench('l1')
    bench.session.append('todo/write', { todos: [{ content: 'gone', status: 'pending' }] })
    expect(view(bench)?.source).toBe('mirrored')
    const task = bench.ctx.delivery.get(bench.agent)!
    bench.ctx.delivery.clear(bench.agent, { id: task.id, revision: task.revision })
    // A cleared task leaves the last mirrored view in place but drops the level
    // the mirror depends on, so a later todo list no longer mirrors.
    bench.session.append('todo/write', { todos: [{ content: 'after clear', status: 'pending' }] })
    expect(view(bench)?.items.map(item => item.content)).toEqual(['gone'])
  })
})
