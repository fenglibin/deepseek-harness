/**
 * Strict replay fold and projection definition for durable delivery
 * checklists. Deliberately separate from the task fold: a checklist write must
 * never widen the `delivery` snapshot's field set, whose decoder rejects
 * unknown keys.
 * @module @deepseek-ai/dsh-delivery/tasks-fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { DeliveryTaskId } from './runtime.ts'
import type {
  DeliveryPhase,
  DeliveryPhaseProgress,
  DeliveryTaskItem,
  DeliveryTaskStatus,
  DeliveryTasksChangeMeta,
  DeliveryTasksState,
  DeliveryTasksView,
} from './types.ts'

/** Lifecycle phases one checklist item may belong to. */
const PHASE_TUPLE = [
  'created',
  'designed',
  'specified',
  'implemented',
  'verified',
  'accepted',
] as const

const PHASES: readonly DeliveryPhase[] = PHASE_TUPLE

/** Progress statuses one checklist item may carry. */
const STATUSES: readonly DeliveryTaskStatus[] = ['pending', 'in_progress', 'completed']

/** Durable checklist write version decoded by this fold. */
const DELIVERY_TASKS_VERSION = 1

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decode and validate one checklist item. */
function decodeItem(value: unknown, index: number): DeliveryTaskItem {
  if (!isRecord(value)) throw new Error(`delivery tasks item ${index} must be a record`)
  const content = value['content']
  if (typeof content !== 'string' || content.trim().length === 0 || content !== content.trim()) {
    throw new Error(`delivery tasks item ${index} content must be non-empty and normalized`)
  }
  const phase = value['phase']
  if (typeof phase !== 'string' || !PHASES.includes(phase as DeliveryPhase)) {
    throw new Error(`delivery tasks item ${index} phase is invalid`)
  }
  const status = value['status']
  if (typeof status !== 'string' || !STATUSES.includes(status as DeliveryTaskStatus)) {
    throw new Error(`delivery tasks item ${index} status is invalid`)
  }
  return { content, phase: phase as DeliveryPhase, status: status as DeliveryTaskStatus }
}

/**
 * Decode a value that declares itself as a delivery checklist write.
 * @param value - candidate source change.
 * @returns the validated write, or `undefined` for another value kind.
 * @throws when a self-declared checklist write is malformed.
 */
export function decodeDeliveryTasks(value: unknown): DeliveryTasksChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'delivery/tasks') return undefined
  if (value['version'] !== DELIVERY_TASKS_VERSION) {
    throw new Error(`unsupported delivery tasks version ${String(value['version'])}`)
  }
  const ref = value['ref']
  if (!isRecord(ref) || typeof ref['id'] !== 'string' || ref['id'].length === 0
    || !Number.isSafeInteger(ref['revision']) || (ref['revision'] as number) < 1) {
    throw new Error('delivery tasks ref must be a non-empty id and a positive revision')
  }
  const changeId = value['changeId']
  if (typeof changeId !== 'string') {
    throw new Error('delivery tasks changeId must be a string')
  }
  const items = value['items']
  if (!Array.isArray(items)) throw new Error('delivery tasks items must be an array')
  const decoded = items.map(decodeItem)
  if (new Set(decoded.map(item => item.content)).size !== decoded.length) {
    throw new Error('delivery tasks item content must be unique within one checklist')
  }
  const updatedAt = value['updatedAt']
  if (!Number.isSafeInteger(updatedAt) || (updatedAt as number) < 0) {
    throw new Error('delivery tasks updatedAt must be a non-negative integer')
  }
  return {
    kind: 'delivery/tasks',
    version: DELIVERY_TASKS_VERSION,
    ref: { id: DeliveryTaskId(ref['id']), revision: ref['revision'] as number },
    changeId,
    items: decoded,
    updatedAt: updatedAt as number,
  }
}

/**
 * Count completed and total items per lifecycle phase.
 * @param items - checklist to aggregate.
 * @returns one counter per phase, zeroed for phases with no items.
 */
export function tasksProgress(items: readonly DeliveryTaskItem[]): Record<DeliveryPhase, DeliveryPhaseProgress> {
  const progress = {} as Record<DeliveryPhase, DeliveryPhaseProgress>
  for (const phase of PHASES) progress[phase] = { done: 0, total: 0 }
  for (const item of items) {
    const entry = progress[item.phase]
    progress[item.phase] = {
      done: entry.done + (item.status === 'completed' ? 1 : 0),
      total: entry.total + 1,
    }
  }
  return progress
}

/** Build the client checklist value from one durable write. */
function tasksView(change: DeliveryTasksChangeMeta): DeliveryTasksView {
  return { changeId: change.changeId, items: change.items, progress: tasksProgress(change.items) }
}

/**
 * Apply one session event to the strict checklist fold.
 * @param state - preceding durable checklist state.
 * @param event - next event in sequence order.
 * @returns the next state; a first decode failure is retained and freezes it.
 */
export function applyDeliveryTasksEvent(state: DeliveryTasksState, event: SessionEvent): DeliveryTasksState {
  if (event.type !== 'delivery/tasks' || state.failure !== null) return state
  try {
    const change = decodeDeliveryTasks(event.data)
    if (change === undefined) return state
    return { current: tasksView(change), failure: null }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `delivery tasks replay failed at session event ${event.seq}: ${message}` }
  }
}

const phaseProgressSchema = zod.object({
  done: zod.number().int().nonnegative(),
  total: zod.number().int().nonnegative(),
})

const tasksViewSchema: ZodType<DeliveryTasksView | null> = zod.union([
  zod.object({
    changeId: zod.string(),
    items: zod.array(zod.object({
      content: zod.string().min(1),
      phase: zod.enum(PHASE_TUPLE),
      status: zod.enum(['pending', 'in_progress', 'completed']),
    })),
    progress: zod.object({
      created: phaseProgressSchema,
      designed: phaseProgressSchema,
      specified: phaseProgressSchema,
      implemented: phaseProgressSchema,
      verified: phaseProgressSchema,
      accepted: phaseProgressSchema,
    }),
  }),
  zod.null(),
])

const tasksStateSchema: ZodType<DeliveryTasksState> = zod.object({
  current: tasksViewSchema,
  failure: zod.string().min(1).nullable(),
}).strict()

/** Strict host checklist state exposing per-phase progress to clients. */
export const deliveryTasksProjectionDefinition = {
  key: 'delivery-tasks',
  stateSchema: tasksStateSchema,
  init: (): DeliveryTasksState => ({ current: null, failure: null }),
  apply: applyDeliveryTasksEvent,
  wire: { viewSchema: tasksViewSchema, view: state => state.current },
  stateVersion: 1,
} satisfies ProjectionDefinition<'delivery-tasks', DeliveryTasksState>
