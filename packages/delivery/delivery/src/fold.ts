/** Pure replay fold and strict decoder for durable delivery changes. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DELIVERY_CHANGE_VERSION, DeliveryTaskId } from './runtime.ts'
import type {
  DeliveryChangeMeta,
  DeliveryClearChangeMeta,
  DeliveryLevel,
  DeliveryPhase,
  DeliveryRecordChangeMeta,
  DeliveryRecordDesignMeta,
  DeliveryRecordSpecMeta,
  DeliverySnapshot,
  DeliverySnapshotChangeMeta,
  DeliveryTaskRef,
  FoldedDelivery,
} from './types.ts'

const SNAPSHOT_OPERATIONS: ReadonlySet<'create' | 'advance'> = new Set(['create', 'advance'])
const PHASES: ReadonlySet<DeliveryPhase> = new Set([
  'created',
  'designed',
  'specified',
  'implemented',
  'verified',
  'accepted',
])
const LEVELS: ReadonlySet<DeliveryLevel> = new Set(['l0', 'l1', 'l2'])

/** Ordered phases each task level must traverse in sequence. */
const LEVEL_PHASES: Record<DeliveryLevel, readonly DeliveryPhase[]> = {
  l0: ['created', 'implemented', 'verified', 'accepted'],
  l1: ['created', 'designed', 'implemented', 'verified', 'accepted'],
  l2: ['created', 'designed', 'specified', 'implemented', 'verified', 'accepted'],
}

/** Mutable accumulator kept private to the pure fold. */
export interface DeliveryFoldState {
  task: DeliverySnapshot | undefined
  createdAt: number | undefined
  updatedAt: number | undefined
  lastRef: DeliveryTaskRef | undefined
  seenTaskIds: Set<DeliverySnapshot['id']>
}

/**
 * Build an empty replay accumulator.
 * @returns mutable state with no current task or prior ref.
 */
export function emptyDeliveryFoldState(): DeliveryFoldState {
  return {
    task: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    seenTaskIds: new Set(),
  }
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require one positive safe integer. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`delivery change ${field} must be a positive safe integer`)
  }
  return value
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`delivery change ${field} must be a non-negative safe integer`)
  }
  return value
}

/** Decode and validate one task snapshot. */
function decodeSnapshot(value: unknown): DeliverySnapshot {
  if (!isRecord(value)) throw new Error('delivery change task must be a record')
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('delivery change task.id must be a non-empty string')
  }
  if (typeof value['objective'] !== 'string' || value['objective'].trim().length === 0
    || value['objective'] !== value['objective'].trim()) {
    throw new Error('delivery change task.objective must be non-empty and normalized')
  }
  if (typeof value['phase'] !== 'string' || !PHASES.has(value['phase'] as DeliveryPhase)) {
    throw new Error('delivery change task.phase is invalid')
  }
  if (typeof value['level'] !== 'string' || !LEVELS.has(value['level'] as DeliveryLevel)) {
    throw new Error('delivery change task.level is invalid')
  }
  if (Object.keys(value).sort().join(',') !== 'changeCount,designCount,id,level,objective,phase,revision,specCount') {
    throw new Error('delivery change task must have exactly changeCount, designCount, id, level, objective, phase, revision, specCount fields')
  }
  return {
    id: DeliveryTaskId(value['id']),
    revision: positiveInteger(value['revision'], 'task.revision'),
    objective: value['objective'],
    phase: value['phase'] as DeliveryPhase,
    level: value['level'] as DeliveryLevel,
    changeCount: nonNegativeInteger(value['changeCount'], 'task.changeCount'),
    designCount: nonNegativeInteger(value['designCount'], 'task.designCount'),
    specCount: nonNegativeInteger(value['specCount'], 'task.specCount'),
  }
}

/** Decode and validate one ref. */
function decodeRef(value: unknown): DeliveryTaskRef {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'id,revision') {
    throw new Error('delivery ref must have exactly id and revision fields')
  }
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('delivery ref id must be a non-empty string')
  }
  return { id: DeliveryTaskId(value['id']), revision: positiveInteger(value['revision'], 'ref.revision') }
}

/**
 * Decode a value that declares itself as a delivery change. Unrelated values
 * return `undefined`; malformed delivery changes fail replay loudly.
 * @param value - candidate source change.
 * @returns validated delivery change or `undefined` for another value kind.
 */
export function decodeDeliveryChange(value: unknown): DeliveryChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'delivery/change') return undefined
  if (value['version'] !== DELIVERY_CHANGE_VERSION) {
    throw new Error(`unsupported delivery change version ${String(value['version'])}`)
  }
  const operation = value['operation']
  if (operation === 'clear') {
    if (Object.keys(value).sort().join(',') !== 'cleared,clearedAt,kind,operation,version') {
      throw new Error('delivery clear change must have exactly cleared, clearedAt, kind, operation, version fields')
    }
    return {
      kind: 'delivery/change',
      version: DELIVERY_CHANGE_VERSION,
      operation: 'clear',
      cleared: decodeRef(value['cleared']),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt'),
    } satisfies DeliveryClearChangeMeta
  }
  if (operation === 'record-change') {
    if (Object.keys(value).sort().join(',') !== 'changeCount,kind,operation,ref,text,updatedAt,version') {
      throw new Error('delivery record change must have exactly changeCount, kind, operation, ref, text, updatedAt, version fields')
    }
    const text = value['text']
    if (typeof text !== 'string' || text.trim().length === 0 || text !== text.trim()) {
      throw new Error('delivery record change text must be non-empty and normalized')
    }
    return {
      kind: 'delivery/change',
      version: DELIVERY_CHANGE_VERSION,
      operation: 'record-change',
      ref: decodeRef(value['ref']),
      text,
      changeCount: nonNegativeInteger(value['changeCount'], 'changeCount'),
      updatedAt: nonNegativeInteger(value['updatedAt'], 'updatedAt'),
    } satisfies DeliveryRecordChangeMeta
  }
  if (operation === 'record-design') {
    if (Object.keys(value).sort().join(',') !== 'designCount,kind,operation,ref,text,updatedAt,version') {
      throw new Error('delivery record design must have exactly designCount, kind, operation, ref, text, updatedAt, version fields')
    }
    const text = value['text']
    if (typeof text !== 'string' || text.trim().length === 0 || text !== text.trim()) {
      throw new Error('delivery record design text must be non-empty and normalized')
    }
    return {
      kind: 'delivery/change',
      version: DELIVERY_CHANGE_VERSION,
      operation: 'record-design',
      ref: decodeRef(value['ref']),
      text,
      designCount: nonNegativeInteger(value['designCount'], 'designCount'),
      updatedAt: nonNegativeInteger(value['updatedAt'], 'updatedAt'),
    } satisfies DeliveryRecordDesignMeta
  }
  if (operation === 'record-spec') {
    if (Object.keys(value).sort().join(',') !== 'kind,operation,ref,specCount,text,updatedAt,version') {
      throw new Error('delivery record spec must have exactly kind, operation, ref, specCount, text, updatedAt, version fields')
    }
    const text = value['text']
    if (typeof text !== 'string' || text.trim().length === 0 || text !== text.trim()) {
      throw new Error('delivery record spec text must be non-empty and normalized')
    }
    return {
      kind: 'delivery/change',
      version: DELIVERY_CHANGE_VERSION,
      operation: 'record-spec',
      ref: decodeRef(value['ref']),
      text,
      specCount: nonNegativeInteger(value['specCount'], 'specCount'),
      updatedAt: nonNegativeInteger(value['updatedAt'], 'updatedAt'),
    } satisfies DeliveryRecordSpecMeta
  }
  if (typeof operation !== 'string' || !SNAPSHOT_OPERATIONS.has(operation as 'create' | 'advance')) {
    throw new Error('delivery change operation is invalid')
  }
  if (Object.keys(value).sort().join(',') !== 'createdAt,kind,operation,task,updatedAt,version') {
    throw new Error('delivery snapshot change must have exactly createdAt, kind, operation, task, updatedAt, version fields')
  }
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt')
  if (updatedAt < createdAt) throw new Error('delivery change updatedAt cannot precede createdAt')
  return {
    kind: 'delivery/change',
    version: DELIVERY_CHANGE_VERSION,
    operation: operation as 'create' | 'advance',
    task: decodeSnapshot(value['task']),
    createdAt,
    updatedAt,
  } satisfies DeliverySnapshotChangeMeta
}

/** Require one exact next revision of the current task. */
function requireNextRevision(current: DeliverySnapshot, next: DeliveryTaskRef, operation: string): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`delivery ${operation} must advance the current task by one revision`)
  }
}

/**
 * Return the next allowed phase after `current` for the task's level, or
 * `undefined` when `current` is not a phase of that level or is already final.
 * @param level - the task's fixed size class.
 * @param current - the task's current phase.
 * @returns the single legal next phase, or `undefined` for none.
 */
export function nextDeliveryPhase(level: DeliveryLevel, current: DeliveryPhase): DeliveryPhase | undefined {
  const phases = LEVEL_PHASES[level]
  const index = phases.indexOf(current)
  if (index < 0 || index === phases.length - 1) return undefined
  return phases[index + 1]
}

/**
 * Return the revision identity carried by a snapshot, record, or tombstone.
 * @param change - decoded delivery mutation.
 * @returns stable identity used to reconcile a deferred change with its log event.
 */
export function deliveryChangeRef(change: DeliveryChangeMeta): DeliveryTaskRef {
  if (change.operation === 'clear') return change.cleared
  if (change.operation === 'record-change' || change.operation === 'record-design'
    || change.operation === 'record-spec') return change.ref
  return { id: change.task.id, revision: change.task.revision }
}

/**
 * Validate and apply one decoded change to a mutable accumulator.
 * @param state - preceding durable delivery projection.
 * @param change - decoded full snapshot, record, or clear tombstone.
 */
export function applyDeliveryChange(state: DeliveryFoldState, change: DeliveryChangeMeta): void {
  const ref = deliveryChangeRef(change)
  if (change.operation === 'clear') {
    const current = state.task
    if (current === undefined) throw new Error('delivery clear requires a current task')
    requireNextRevision(current, change.cleared, 'clear')
    /* v8 ignore next -- a current task established by this fold always has an updatedAt */
    if (state.updatedAt === undefined) throw new Error('current task fold lacks updatedAt')
    if (change.clearedAt < state.updatedAt) {
      throw new Error('delivery clear timestamp cannot precede the current task update')
    }
    state.task = undefined
    state.createdAt = undefined
    state.updatedAt = undefined
    state.lastRef = ref
    return
  }
  if (change.operation === 'record-change') {
    const current = state.task
    if (current === undefined) throw new Error('delivery record-change requires a current task')
    requireNextRevision(current, change.ref, 'record-change')
    if (change.changeCount !== current.changeCount + 1) {
      throw new Error('delivery record-change must increment changeCount by one')
    }
    /* v8 ignore next -- a current task established by this fold always has an updatedAt */
    if (state.updatedAt === undefined) throw new Error('current task fold lacks updatedAt')
    if (change.updatedAt < state.updatedAt) {
      throw new Error('delivery record-change timestamp cannot precede the current task update')
    }
    state.task = { ...current, revision: change.ref.revision, changeCount: change.changeCount }
    state.updatedAt = change.updatedAt
    state.lastRef = ref
    return
  }
  if (change.operation === 'record-design') {
    const current = state.task
    if (current === undefined) throw new Error('delivery record-design requires a current task')
    requireNextRevision(current, change.ref, 'record-design')
    if (change.designCount !== current.designCount + 1) {
      throw new Error('delivery record-design must increment designCount by one')
    }
    /* v8 ignore next -- a current task established by this fold always has an updatedAt */
    if (state.updatedAt === undefined) throw new Error('current task fold lacks updatedAt')
    if (change.updatedAt < state.updatedAt) {
      throw new Error('delivery record-design timestamp cannot precede the current task update')
    }
    state.task = { ...current, revision: change.ref.revision, designCount: change.designCount }
    state.updatedAt = change.updatedAt
    state.lastRef = ref
    return
  }
  if (change.operation === 'record-spec') {
    const current = state.task
    if (current === undefined) throw new Error('delivery record-spec requires a current task')
    requireNextRevision(current, change.ref, 'record-spec')
    if (change.specCount !== current.specCount + 1) {
      throw new Error('delivery record-spec must increment specCount by one')
    }
    /* v8 ignore next -- a current task established by this fold always has an updatedAt */
    if (state.updatedAt === undefined) throw new Error('current task fold lacks updatedAt')
    if (change.updatedAt < state.updatedAt) {
      throw new Error('delivery record-spec timestamp cannot precede the current task update')
    }
    state.task = { ...current, revision: change.ref.revision, specCount: change.specCount }
    state.updatedAt = change.updatedAt
    state.lastRef = ref
    return
  }
  if (change.operation === 'create') {
    if (change.task.revision !== 1 || change.task.phase !== 'created' || change.task.changeCount !== 0
      || change.task.designCount !== 0 || change.task.specCount !== 0
      || (state.task !== undefined && state.task.phase !== 'accepted')
      || state.seenTaskIds.has(change.task.id)) {
      throw new Error('delivery create requires a fresh created revision-one task with zero changes')
    }
    state.seenTaskIds.add(change.task.id)
  } else {
    const current = state.task
    if (current === undefined) throw new Error('delivery advance requires a current task')
    requireNextRevision(current, change.task, 'advance')
    if (change.task.id !== current.id || change.task.objective !== current.objective
      || change.task.level !== current.level || change.task.changeCount !== current.changeCount
      || change.task.designCount !== current.designCount
      || change.task.specCount !== current.specCount) {
      throw new Error('delivery advance cannot change objective, level, changeCount, designCount, or specCount')
    }
    /* v8 ignore next -- a current task established by this fold always has an updatedAt */
    if (state.updatedAt === undefined) throw new Error('current task fold lacks updatedAt')
    if (change.createdAt !== state.createdAt || change.updatedAt < state.updatedAt) {
      throw new Error('delivery advance does not preserve the current timestamps')
    }
    const expected = nextDeliveryPhase(current.level, current.phase)
    if (expected === undefined || change.task.phase !== expected) {
      throw new Error(`delivery advance from phase "${current.phase}" at level "${current.level}" is invalid`)
    }
  }
  state.task = change.task
  state.createdAt = change.createdAt
  state.updatedAt = change.updatedAt
  state.lastRef = ref
}

/**
 * Apply one session event to the strict durable delivery fold.
 * @param state - mutable fold accumulator.
 * @param event - next event in sequence order.
 */
export function applyDeliveryEvent(state: DeliveryFoldState, event: SessionEvent): void {
  if (event.type !== 'delivery/change') return
  const change = decodeDeliveryChange(event.data)
  /* v8 ignore next -- the event's declared payload always identifies itself as a delivery change */
  if (change === undefined) throw new Error(`delivery change at session event ${event.seq} has an invalid kind`)
  applyDeliveryChange(state, change)
}

/**
 * Fold current task state from a contiguous session event log.
 * @param events - session events in sequence order.
 * @returns a fresh durable projection.
 */
export function foldDelivery(events: readonly SessionEvent[]): FoldedDelivery {
  const state = emptyDeliveryFoldState()
  for (const event of events) applyDeliveryEvent(state, event)
  return {
    ...state.task === undefined ? {} : { task: { ...state.task } },
    ...state.createdAt === undefined ? {} : { createdAt: state.createdAt },
    ...state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt },
    ...state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } },
  }
}
