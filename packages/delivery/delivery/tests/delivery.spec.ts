import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import DeliveryService, {
  DeliveryError,
  DeliveryTaskId,
  decodeDeliveryChange,
  foldDelivery,
} from '@deepseek-ai/dsh-delivery'
import type { DeliverySnapshotChangeMeta } from '@deepseek-ai/dsh-delivery'

interface StubAgent {
  agent: Agent
  session: Session
}

/** Build a registry-compatible agent around one concrete session. */
function stubAgentForSession(session: Session): StubAgent {
  const id = session.id
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** Build a registry-compatible agent around a fresh session. */
function stubAgent(rawId: string, seed?: readonly import('@deepseek-ai/dsh-session').SessionEvent[]): StubAgent {
  return stubAgentForSession(Session.create(SessionId(rawId), seed))
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(DeliveryService)
  const stub = stubAgentForSession(ctx.sessions.create(SessionId(`delivery-test-${Math.random()}`)))
  ctx.agents.register(stub.agent)
  return { ctx, ...stub }
}

describe('DeliveryService creation and replay', () => {
  it('does not activate without the required projection registry', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(DeliveryService)
    expect(ctx.get('delivery')).toBeUndefined()
  })

  it('creates a task and writes one durable change', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const { ctx, agent, session } = await harness()
    const seen: string[] = []
    ctx.on('delivery/changed', ({ change }) => { seen.push(change.operation) })

    const task = ctx.delivery.create(agent, { objective: '  finish the feature  ' })

    expect(task).toMatchObject({
      objective: 'finish the feature',
      phase: 'created',
      level: 'l0',
      revision: 1,
      changeCount: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    })
    expect(task.id).toMatch(/^task-/)
    expect(seen).toEqual(['create'])
    expect(session.events.map(event => event.type)).toEqual(['delivery/change'])
    expect(foldDelivery(session.events)).toMatchObject({ task: { id: task.id }, lastRef: { revision: 1 } })
    vi.useRealTimers()
  })

  it('validates create input and rejects an existing non-accepted task', async () => {
    const { ctx, agent } = await harness()
    expect(() => ctx.delivery.create(agent, { objective: '   ' })).toThrow(expect.objectContaining({
      code: 'DELIVERY_INVALID_OBJECTIVE',
    }))
    expect(() => ctx.delivery.create(agent, { objective: 'x', level: 'l9' as never })).toThrow(DeliveryError)
    expect(ctx.delivery.create(agent, { objective: 'x' }).level).toBe('l0')
    expect(() => ctx.delivery.create(agent, { objective: 'second' })).toThrow(expect.objectContaining({
      code: 'DELIVERY_ALREADY_EXISTS',
    }))
  })

  it('restores a seeded task through replay', async () => {
    const first = await harness()
    const created = first.ctx.delivery.create(first.agent, { objective: 'seed me', level: 'l1' })

    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(DeliveryService)
    const resumed = stubAgent('seeded-delivery', first.session.events)
    ctx.agents.register(resumed.agent)
    expect(ctx.delivery.get(resumed.agent)).toMatchObject({
      id: created.id,
      objective: 'seed me',
      level: 'l1',
      phase: 'created',
    })
  })
})

describe('DeliveryService mutations', () => {
  it('records changes with monotonic revision and change count', async () => {
    const { ctx, agent, session } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'record changes' })
    task = ctx.delivery.recordChange(agent, task, '  first change  ')
    expect(task).toMatchObject({ revision: 2, changeCount: 1 })
    task = ctx.delivery.recordChange(agent, task, 'second change')
    expect(task).toMatchObject({ revision: 3, changeCount: 2 })
    expect(() => ctx.delivery.recordChange(agent, task, '   ')).toThrow(expect.objectContaining({
      code: 'DELIVERY_INVALID_CHANGE_TEXT',
    }))
    expect(foldDelivery(session.events)).toMatchObject({ task: { revision: 3, changeCount: 2 } })
  })

  it('records designs with monotonic revision and design count', async () => {
    const { ctx, agent } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'record designs', level: 'l1' })
    task = ctx.delivery.recordDesign(agent, task, '  the design  ')
    expect(task).toMatchObject({ revision: 2, designCount: 1, changeCount: 0 })
    task = ctx.delivery.recordDesign(agent, task, 'second design')
    expect(task).toMatchObject({ revision: 3, designCount: 2 })
    expect(() => ctx.delivery.recordDesign(agent, task, '   ')).toThrow(expect.objectContaining({
      code: 'DELIVERY_INVALID_DESIGN_TEXT',
    }))
  })

  it('records specs with monotonic revision and spec count', async () => {
    const { ctx, agent } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'record specs', level: 'l2' })
    task = ctx.delivery.recordSpec(agent, task, '  the spec  ')
    expect(task).toMatchObject({ revision: 2, specCount: 1, changeCount: 0, designCount: 0 })
    task = ctx.delivery.recordSpec(agent, task, 'second spec')
    expect(task).toMatchObject({ revision: 3, specCount: 2 })
    expect(() => ctx.delivery.recordSpec(agent, task, '   ')).toThrow(expect.objectContaining({
      code: 'DELIVERY_INVALID_SPEC_TEXT',
    }))
  })

  it('advances an l0 task through implemented, verified, accepted', async () => {
    const { ctx, agent, session } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'l0 lifecycle' })
    task = ctx.delivery.recordChange(agent, task, 'the fix')
    task = ctx.delivery.advance(agent, task, 'implemented')
    expect(task).toMatchObject({ phase: 'implemented', revision: 3 })
    task = ctx.delivery.advance(agent, task, 'verified')
    task = ctx.delivery.advance(agent, task, 'accepted')
    expect(task).toMatchObject({ phase: 'accepted', revision: 5 })
    expect(foldDelivery(session.events)).toMatchObject({ task: { phase: 'accepted', revision: 5 } })
  })

  it('rejects phase skips and non-sequential advances', async () => {
    const { ctx, agent } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'skip check' })
    expect(() => ctx.delivery.advance(agent, task, 'verified')).toThrow(expect.objectContaining({
      code: 'DELIVERY_INVALID_TRANSITION',
    }))
    expect(() => ctx.delivery.advance(agent, task, 'created')).toThrow(expect.objectContaining({
      code: 'DELIVERY_INVALID_TRANSITION',
    }))
    task = ctx.delivery.advance(agent, task, 'implemented')
    expect(() => ctx.delivery.advance(agent, task, 'accepted')).toThrow(expect.objectContaining({
      code: 'DELIVERY_INVALID_TRANSITION',
    }))
  })

  it('rejects advancing a task already at its final phase', async () => {
    const { ctx, agent } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'terminal' })
    task = ctx.delivery.recordChange(agent, task, 'the fix')
    task = ctx.delivery.advance(agent, task, 'implemented')
    task = ctx.delivery.advance(agent, task, 'verified')
    task = ctx.delivery.advance(agent, task, 'accepted')
    expect(() => ctx.delivery.advance(agent, task, 'accepted')).toThrow(
      expect.objectContaining({ code: 'DELIVERY_INVALID_TRANSITION' }),
    )
  })

  it('routes l1 and l2 tasks through their full phase orders', async () => {
    const l1 = await harness()
    let task = l1.ctx.delivery.create(l1.agent, { objective: 'l1 path', level: 'l1' })
    task = l1.ctx.delivery.advance(l1.agent, task, 'designed')
    expect(task).toMatchObject({ phase: 'designed' })
    expect(() => l1.ctx.delivery.advance(l1.agent, task, 'specified')).toThrow(expect.objectContaining({
      code: 'DELIVERY_INVALID_TRANSITION',
    }))

    const l2 = await harness()
    let task2 = l2.ctx.delivery.create(l2.agent, { objective: 'l2 path', level: 'l2' })
    task2 = l2.ctx.delivery.advance(l2.agent, task2, 'designed')
    task2 = l2.ctx.delivery.advance(l2.agent, task2, 'specified')
    expect(task2).toMatchObject({ phase: 'specified' })
  })

  it('walks an l1 task through the full lifecycle to accepted', async () => {
    const { ctx, agent, session } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'l1 full lifecycle', level: 'l1' })
    task = ctx.delivery.recordDesign(agent, task, 'the design')
    task = ctx.delivery.advance(agent, task, 'designed')
    task = ctx.delivery.recordChange(agent, task, 'the change')
    task = ctx.delivery.advance(agent, task, 'implemented')
    task = ctx.delivery.advance(agent, task, 'verified')
    task = ctx.delivery.advance(agent, task, 'accepted')
    expect(task).toMatchObject({ phase: 'accepted', designCount: 1, changeCount: 1, level: 'l1' })
    expect(foldDelivery(session.events)).toMatchObject({ task: { phase: 'accepted', level: 'l1' } })
  })

  it('walks an l2 task through the full lifecycle to accepted', async () => {
    const { ctx, agent, session } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'l2 full lifecycle', level: 'l2' })
    task = ctx.delivery.recordDesign(agent, task, 'the design')
    task = ctx.delivery.advance(agent, task, 'designed')
    task = ctx.delivery.recordSpec(agent, task, 'the spec')
    task = ctx.delivery.advance(agent, task, 'specified')
    task = ctx.delivery.recordChange(agent, task, 'the change')
    task = ctx.delivery.advance(agent, task, 'implemented')
    task = ctx.delivery.advance(agent, task, 'verified')
    task = ctx.delivery.advance(agent, task, 'accepted')
    expect(task).toMatchObject({ phase: 'accepted', specCount: 1, designCount: 1, changeCount: 1, level: 'l2' })
    expect(foldDelivery(session.events)).toMatchObject({ task: { phase: 'accepted', level: 'l2' } })
  })

  it('replaces an accepted task with a fresh one and retains the old id', async () => {
    const { ctx, agent } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'first' })
    task = ctx.delivery.recordChange(agent, task, 'the fix')
    task = ctx.delivery.advance(agent, task, 'implemented')
    task = ctx.delivery.advance(agent, task, 'verified')
    task = ctx.delivery.advance(agent, task, 'accepted')
    const next = ctx.delivery.create(agent, { objective: 'second' })
    expect(next.id).not.toBe(task.id)
    expect(next).toMatchObject({ phase: 'created', revision: 1, changeCount: 0 })
  })

  it('clears through a revisioned tombstone and permits a fresh task', async () => {
    const { ctx, agent, session } = await harness()
    const task = ctx.delivery.create(agent, { objective: 'temporary' })
    const tombstone = ctx.delivery.clear(agent, task)
    expect(tombstone).toEqual({ id: task.id, revision: 2 })
    expect(ctx.delivery.get(agent)).toBeUndefined()
    expect(() => ctx.delivery.clear(agent, task)).toThrow(expect.objectContaining({ code: 'DELIVERY_TASK_NOT_FOUND' }))
    const next = ctx.delivery.create(agent, { objective: 'fresh' })
    expect(next.id).not.toBe(task.id)
    expect(foldDelivery(session.events)).toMatchObject({ lastRef: { id: next.id, revision: 1 }, task: { id: next.id, revision: 1 } })
  })

  it('rejects stale revisions through compare-and-set', async () => {
    const { ctx, agent } = await harness()
    const task = ctx.delivery.create(agent, { objective: 'cas' })
    const advanced = ctx.delivery.recordChange(agent, task, 'change')
    expect(() => ctx.delivery.advance(agent, task, 'implemented')).toThrow(expect.objectContaining({
      code: 'DELIVERY_STALE_REVISION',
    }))
    expect(ctx.delivery.advance(agent, advanced, 'implemented')).toMatchObject({ phase: 'implemented' })
  })

  it('requires the exact live registry instance for reads and mutations', async () => {
    const { ctx, agent } = await harness()
    const impostor = stubAgentForSession(Session.create(agent.id)).agent
    expect(() => ctx.delivery.get(impostor)).toThrow(expect.objectContaining({ code: 'DELIVERY_AGENT_NOT_LIVE' }))
    expect(() => ctx.delivery.create(impostor, { objective: 'no' })).toThrow(expect.objectContaining({
      code: 'DELIVERY_AGENT_NOT_LIVE',
    }))
  })

  it('keeps mutation timestamps monotonic when the wall clock moves backward', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const { ctx, agent, session } = await harness()
    let task = ctx.delivery.create(agent, { objective: 'monotonic time' })
    vi.setSystemTime(90)
    task = ctx.delivery.recordChange(agent, task, 'backwards clock')
    expect(task.updatedAt).toBe(100)
    expect(() => foldDelivery(session.events)).not.toThrow()
    vi.useRealTimers()
  })
})

describe('delivery replay validation', () => {
  function snapshotChange(overrides: Partial<DeliverySnapshotChangeMeta> = {}): DeliverySnapshotChangeMeta {
    return {
      kind: 'delivery/change',
      version: 1,
      operation: 'create',
      task: {
        id: DeliveryTaskId('task-validation'),
        revision: 1,
        objective: 'validate',
        phase: 'created',
        level: 'l0',
        changeCount: 0,
        designCount: 0,
        specCount: 0,
      },
      createdAt: 10,
      updatedAt: 10,
      ...overrides,
    }
  }

  it('rejects unsupported versions, operations, and extra top-level fields', () => {
    expect(decodeDeliveryChange(undefined)).toBeUndefined()
    expect(decodeDeliveryChange({ kind: 'other' })).toBeUndefined()
    expect(() => decodeDeliveryChange({ ...snapshotChange(), version: 2 })).toThrow('unsupported delivery change version')
    expect(() => decodeDeliveryChange({ ...snapshotChange(), operation: 'explode' })).toThrow('operation is invalid')
    expect(() => decodeDeliveryChange({ ...snapshotChange(), extra: true })).toThrow('exactly')
  })

  it('rejects malformed snapshots and non-sequential transitions', () => {
    const base = snapshotChange()
    const badSnapshots: unknown[] = [
      null,
      { ...base.task, extra: true },
      { ...base.task, id: '' },
      { ...base.task, objective: ' ' },
      { ...base.task, phase: 'unknown' },
      { ...base.task, level: 'l9' },
      { ...base.task, revision: 0 },
      { ...base.task, changeCount: -1 },
    ]
    for (const task of badSnapshots) expect(() => decodeDeliveryChange({ ...base, task })).toThrow()

    const advance: DeliverySnapshotChangeMeta = { ...base, operation: 'advance', task: { ...base.task, revision: 2, phase: 'verified' } }
    const session = Session.create(SessionId('validation-skip'))
    session.append('delivery/change', base)
    session.append('delivery/change', advance)
    expect(() => foldDelivery(session.events)).toThrow('invalid')
  })
})
