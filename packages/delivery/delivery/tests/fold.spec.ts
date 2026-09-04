/**
 * Pure replay-fold coverage: the strict decoder's rejection paths, the
 * compare-and-set transition rules, and the phase ladder boundary. These
 * branch through `foldDelivery` and `decodeDeliveryChange` so every owned
 * validation message is pinned to a behavior, matching the goal fold suite.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  DeliveryTaskId,
  decodeDeliveryChange,
  foldDelivery,
  nextDeliveryPhase,
} from '@deepseek-ai/dsh-delivery'
import type {
  DeliveryClearChangeMeta,
  DeliveryPhase,
  DeliveryRecordChangeMeta,
  DeliveryRecordDesignMeta,
  DeliveryRecordSpecMeta,
  DeliverySnapshotChangeMeta,
} from '@deepseek-ai/dsh-delivery'

/** A valid L0 create snapshot for one task id. */
function create(
  id: string,
  overrides: Partial<DeliverySnapshotChangeMeta['task']> = {},
): DeliverySnapshotChangeMeta {
  return {
    kind: 'delivery/change',
    version: 1,
    operation: 'create',
    task: {
      id: DeliveryTaskId(id),
      revision: 1,
      objective: 'validate',
      phase: 'created',
      level: 'l0',
      changeCount: 0,
      designCount: 0,
      specCount: 0,
      ...overrides,
    },
    createdAt: 10,
    updatedAt: 10,
  }
}

/** A valid clear tombstone advancing one task id by one revision. */
function clear(id: string, revision: number, clearedAt = 20): DeliveryClearChangeMeta {
  return {
    kind: 'delivery/change',
    version: 1,
    operation: 'clear',
    cleared: { id: DeliveryTaskId(id), revision },
    clearedAt,
  }
}

/** A valid incremental record-change for one task id. */
function record(
  id: string,
  revision: number,
  text: string,
  changeCount: number,
  updatedAt = 20,
): DeliveryRecordChangeMeta {
  return {
    kind: 'delivery/change',
    version: 1,
    operation: 'record-change',
    ref: { id: DeliveryTaskId(id), revision },
    text,
    changeCount,
    updatedAt,
  }
}

/** A valid incremental record-design for one task id. */
function design(
  id: string,
  revision: number,
  text: string,
  designCount: number,
  updatedAt = 20,
): DeliveryRecordDesignMeta {
  return {
    kind: 'delivery/change',
    version: 1,
    operation: 'record-design',
    ref: { id: DeliveryTaskId(id), revision },
    text,
    designCount,
    updatedAt,
  }
}

/** A valid incremental record-spec for one task id. */
function spec(
  id: string,
  revision: number,
  text: string,
  specCount: number,
  updatedAt = 20,
): DeliveryRecordSpecMeta {
  return {
    kind: 'delivery/change',
    version: 1,
    operation: 'record-spec',
    ref: { id: DeliveryTaskId(id), revision },
    text,
    specCount,
    updatedAt,
  }
}

/** An advance snapshot derived from a preceding snapshot, one phase forward. */
function advanceFrom(prev: DeliverySnapshotChangeMeta, phase: DeliveryPhase): DeliverySnapshotChangeMeta {
  return {
    ...prev,
    operation: 'advance',
    task: { ...prev.task, revision: prev.task.revision + 1, phase },
  }
}

/** Fold a sequence of delivery payloads in order, surfacing any replay error. */
function foldChanges(...changes: unknown[]): ReturnType<typeof foldDelivery> {
  const session = Session.create(SessionId('fold-test'))
  for (const change of changes) session.append('delivery/change', change as never)
  return foldDelivery(session.events)
}

describe('decodeDeliveryChange', () => {
  it('decodes valid clear, record-change, record-design, and record-spec payloads', () => {
    expect(decodeDeliveryChange(clear('task-1', 2))).toMatchObject({ operation: 'clear' })
    expect(decodeDeliveryChange(record('task-1', 2, 'text', 1))).toMatchObject({ operation: 'record-change' })
    expect(decodeDeliveryChange(design('task-1', 2, 'text', 1))).toMatchObject({ operation: 'record-design' })
    expect(decodeDeliveryChange(spec('task-1', 2, 'text', 1))).toMatchObject({ operation: 'record-spec' })
  })

  it('rejects malformed record-design fields and text', () => {
    const base = design('task-1', 2, 'text', 1)
    expect(() => decodeDeliveryChange({ ...base, extra: true }))
      .toThrow('delivery record design must have exactly designCount, kind, operation, ref, text, updatedAt, version fields')
    expect(() => decodeDeliveryChange({ ...base, text: ' ' }))
      .toThrow('delivery record design text must be non-empty and normalized')
    expect(() => decodeDeliveryChange({ ...base, text: ' padded ' }))
      .toThrow('delivery record design text must be non-empty and normalized')
  })

  it('rejects malformed record-spec fields and text', () => {
    const base = spec('task-1', 2, 'text', 1)
    expect(() => decodeDeliveryChange({ ...base, extra: true }))
      .toThrow('delivery record spec must have exactly kind, operation, ref, specCount, text, updatedAt, version fields')
    expect(() => decodeDeliveryChange({ ...base, text: ' ' }))
      .toThrow('delivery record spec text must be non-empty and normalized')
    expect(() => decodeDeliveryChange({ ...base, text: ' padded ' }))
      .toThrow('delivery record spec text must be non-empty and normalized')
  })

  it('rejects malformed clear refs and top-level fields', () => {
    const base = clear('task-1', 2)
    expect(() => decodeDeliveryChange({ ...base, cleared: 'not-a-ref' }))
      .toThrow('delivery ref must have exactly id and revision fields')
    expect(() => decodeDeliveryChange({ ...base, cleared: { id: 'task-1', revision: 2, extra: true } }))
      .toThrow('delivery ref must have exactly id and revision fields')
    expect(() => decodeDeliveryChange({ ...base, cleared: { id: '', revision: 2 } }))
      .toThrow('delivery ref id must be a non-empty string')
    expect(() => decodeDeliveryChange({ ...base, cleared: { id: 'task-1', revision: 0 } }))
      .toThrow('must be a positive safe integer')
    expect(() => decodeDeliveryChange({ ...base, extra: true }))
      .toThrow('delivery clear change must have exactly cleared, clearedAt, kind, operation, version fields')
  })

  it('rejects malformed record-change fields and text', () => {
    const base = record('task-1', 2, 'text', 1)
    expect(() => decodeDeliveryChange({ ...base, extra: true }))
      .toThrow('delivery record change must have exactly changeCount, kind, operation, ref, text, updatedAt, version fields')
    expect(() => decodeDeliveryChange({ ...base, text: ' ' }))
      .toThrow('delivery record change text must be non-empty and normalized')
    expect(() => decodeDeliveryChange({ ...base, text: ' padded ' }))
      .toThrow('delivery record change text must be non-empty and normalized')
  })

  it('rejects a snapshot whose updatedAt precedes its createdAt', () => {
    expect(() => decodeDeliveryChange({ ...create('task-1'), updatedAt: 9 }))
      .toThrow('delivery change updatedAt cannot precede createdAt')
  })
})

describe('foldDelivery transitions', () => {
  it('folds an empty log to an empty projection', () => {
    expect(foldChanges()).toEqual({})
  })

  it('returns undefined for an unrelated event kind', () => {
    const session = Session.create(SessionId('fold-unrelated'))
    session.append('turn/start', { turn: 1 })
    session.append('delivery/change', create('task-1'))
    expect(foldDelivery(session.events)).toMatchObject({ task: { id: DeliveryTaskId('task-1') } })
  })

  it('rejects a clear without a current task', () => {
    expect(() => foldChanges(clear('task-1', 2))).toThrow('delivery clear requires a current task')
  })

  it('rejects a clear with a stale revision', () => {
    expect(() => foldChanges(create('task-1'), clear('task-1', 3)))
      .toThrow('delivery clear must advance the current task by one revision')
  })

  it('rejects a clear whose timestamp precedes the current update', () => {
    expect(() => foldChanges(create('task-1'), clear('task-1', 2, 9)))
      .toThrow('delivery clear timestamp cannot precede the current task update')
  })

  it('rejects a record-change without a current task', () => {
    expect(() => foldChanges(record('task-1', 2, 'text', 1)))
      .toThrow('delivery record-change requires a current task')
  })

  it('rejects a record-change with a stale revision or wrong change count', () => {
    expect(() => foldChanges(create('task-1'), record('task-1', 3, 'text', 1)))
      .toThrow('delivery record-change must advance the current task by one revision')
    expect(() => foldChanges(create('task-1'), record('task-1', 2, 'text', 2)))
      .toThrow('delivery record-change must increment changeCount by one')
  })

  it('rejects a record-change whose timestamp precedes the current update', () => {
    expect(() => foldChanges(create('task-1'), record('task-1', 2, 'text', 1, 9)))
      .toThrow('delivery record-change timestamp cannot precede the current task update')
  })

  it('rejects a record-design without a current task', () => {
    expect(() => foldChanges(design('task-1', 2, 'text', 1)))
      .toThrow('delivery record-design requires a current task')
  })

  it('rejects a record-design with a stale revision or wrong design count', () => {
    expect(() => foldChanges(create('task-1'), design('task-1', 3, 'text', 1)))
      .toThrow('delivery record-design must advance the current task by one revision')
    expect(() => foldChanges(create('task-1'), design('task-1', 2, 'text', 2)))
      .toThrow('delivery record-design must increment designCount by one')
  })

  it('rejects a record-design whose timestamp precedes the current update', () => {
    expect(() => foldChanges(create('task-1'), design('task-1', 2, 'text', 1, 9)))
      .toThrow('delivery record-design timestamp cannot precede the current task update')
  })

  it('folds a record-design into an incremented design count', () => {
    const folded = foldChanges(create('task-1'), design('task-1', 2, 'the design', 1))
    expect(folded.task).toMatchObject({ revision: 2, designCount: 1, changeCount: 0 })
  })

  it('rejects a record-spec without a current task', () => {
    expect(() => foldChanges(spec('task-1', 2, 'text', 1)))
      .toThrow('delivery record-spec requires a current task')
  })

  it('rejects a record-spec with a stale revision or wrong spec count', () => {
    expect(() => foldChanges(create('task-1'), spec('task-1', 3, 'text', 1)))
      .toThrow('delivery record-spec must advance the current task by one revision')
    expect(() => foldChanges(create('task-1'), spec('task-1', 2, 'text', 2)))
      .toThrow('delivery record-spec must increment specCount by one')
  })

  it('rejects a record-spec whose timestamp precedes the current update', () => {
    expect(() => foldChanges(create('task-1'), spec('task-1', 2, 'text', 1, 9)))
      .toThrow('delivery record-spec timestamp cannot precede the current task update')
  })

  it('folds a record-spec into an incremented spec count', () => {
    const folded = foldChanges(create('task-1'), spec('task-1', 2, 'the spec', 1))
    expect(folded.task).toMatchObject({ revision: 2, specCount: 1, changeCount: 0, designCount: 0 })
  })

  it('rejects a create that is not a fresh revision-one created task', () => {
    expect(() => foldChanges(create('task-1', { revision: 2 })))
      .toThrow('delivery create requires a fresh created revision-one task with zero changes')
    expect(() => foldChanges(create('task-1', { phase: 'implemented' })))
      .toThrow('delivery create requires a fresh created revision-one task with zero changes')
    expect(() => foldChanges(create('task-1', { changeCount: 1 })))
      .toThrow('delivery create requires a fresh created revision-one task with zero changes')
  })

  it('rejects a create while a non-accepted task is current', () => {
    expect(() => foldChanges(create('task-1'), create('task-2')))
      .toThrow('delivery create requires a fresh created revision-one task with zero changes')
  })

  it('rejects a create that reuses a seen task id', () => {
    const c1 = create('task-1')
    const implemented = advanceFrom(c1, 'implemented')
    const verified = advanceFrom(implemented, 'verified')
    const accepted = advanceFrom(verified, 'accepted')
    expect(() => foldChanges(c1, implemented, verified, accepted, clear('task-1', 5), create('task-1')))
      .toThrow('delivery create requires a fresh created revision-one task with zero changes')
  })

  it('permits replacing an accepted task with a fresh one', () => {
    const c1 = create('task-1')
    const implemented = advanceFrom(c1, 'implemented')
    const verified = advanceFrom(implemented, 'verified')
    const accepted = advanceFrom(verified, 'accepted')
    const folded = foldChanges(c1, implemented, verified, accepted, create('task-2'))
    expect(folded.task).toMatchObject({ id: DeliveryTaskId('task-2'), phase: 'created', revision: 1 })
    expect(folded.lastRef).toEqual({ id: DeliveryTaskId('task-2'), revision: 1 })
  })

  it('rejects an advance without a current task', () => {
    expect(() => foldChanges(advanceFrom(create('task-1'), 'implemented')))
      .toThrow('delivery advance requires a current task')
  })

  it('rejects an advance with a stale revision', () => {
    const c1 = create('task-1')
    const skip = { ...advanceFrom(c1, 'implemented'), task: { ...advanceFrom(c1, 'implemented').task, revision: 3 } }
    expect(() => foldChanges(c1, skip))
      .toThrow('delivery advance must advance the current task by one revision')
  })

  it('rejects an advance that changes objective, level, changeCount, designCount, or specCount', () => {
    const c1 = create('task-1')
    const target = advanceFrom(c1, 'implemented')
    const objective = { ...target, task: { ...target.task, objective: 'changed' } }
    const level = { ...target, task: { ...target.task, level: 'l1' as const } }
    const changeCount = { ...target, task: { ...target.task, changeCount: 1 } }
    const designCount = { ...target, task: { ...target.task, designCount: 1 } }
    const specCount = { ...target, task: { ...target.task, specCount: 1 } }
    const message = 'delivery advance cannot change objective, level, changeCount, designCount, or specCount'
    expect(() => foldChanges(c1, objective)).toThrow(message)
    expect(() => foldChanges(c1, level)).toThrow(message)
    expect(() => foldChanges(c1, changeCount)).toThrow(message)
    expect(() => foldChanges(c1, designCount)).toThrow(message)
    expect(() => foldChanges(c1, specCount)).toThrow(message)
  })

  it('rejects an advance that does not preserve the current timestamps', () => {
    const c1 = create('task-1')
    // A changed createdAt is rejected by the fold.
    const createdAtMismatch = { ...advanceFrom(c1, 'implemented'), createdAt: 11, updatedAt: 11 }
    expect(() => foldChanges(c1, createdAtMismatch))
      .toThrow('delivery advance does not preserve the current timestamps')

    // An updatedAt regression is rejected after a record-change bumps the current update time.
    const advanced: DeliverySnapshotChangeMeta = {
      kind: 'delivery/change',
      version: 1,
      operation: 'advance',
      task: { ...c1.task, revision: 3, phase: 'implemented', changeCount: 1 },
      createdAt: 10,
      updatedAt: 15,
    }
    expect(() => foldChanges(c1, record('task-1', 2, 'bump', 1, 20), advanced))
      .toThrow('delivery advance does not preserve the current timestamps')
  })

  it('rejects an advance to a phase outside the level order', () => {
    const c1 = create('task-1')
    expect(() => foldChanges(c1, advanceFrom(c1, 'verified')))
      .toThrow('delivery advance from phase "created" at level "l0" is invalid')
  })
})

describe('nextDeliveryPhase', () => {
  it('returns the single legal next phase or undefined at the boundary', () => {
    expect(nextDeliveryPhase('l0', 'created')).toBe('implemented')
    expect(nextDeliveryPhase('l0', 'implemented')).toBe('verified')
    expect(nextDeliveryPhase('l0', 'accepted')).toBeUndefined()
    expect(nextDeliveryPhase('l1', 'created')).toBe('designed')
    expect(nextDeliveryPhase('l1', 'designed')).toBe('implemented')
    expect(nextDeliveryPhase('l2', 'specified')).toBe('implemented')
    expect(nextDeliveryPhase('l2', 'accepted')).toBeUndefined()
    // A phase that is not part of the level's order has no successor.
    expect(nextDeliveryPhase('l0', 'designed')).toBeUndefined()
  })
})
