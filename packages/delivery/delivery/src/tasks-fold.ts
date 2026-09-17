/**
 * Strict replay fold and projection definition for durable delivery
 * checklists. Deliberately separate from the task fold: a checklist write must
 * never widen the `delivery` snapshot's field set, whose decoder rejects
 * unknown keys.
 * @module @deepseek-ai/dsh-delivery/tasks-fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: includes the todo domain's `todo/write` event declaration and its
// payload type, which this fold consumes to mirror an l1 task's todo list.
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { DeliveryTaskId } from './runtime.ts'
import type {
  DeliveryChangeMeta,
  DeliveryLevel,
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
  return {
    changeId: change.changeId,
    items: change.items,
    progress: tasksProgress(change.items),
    source: 'recorded',
  }
}

/**
 * Track the task's level and phase from one `delivery/change` event.
 *
 * The checklist projection needs both because mirroring a `todo_write` list is
 * an l1-only behavior, and a mirrored item needs a phase to belong to. Reading
 * them here keeps the checklist fold independent of the task fold, which a
 * projection unit cannot consult.
 * @param state - preceding checklist state.
 * @param change - decoded delivery change.
 * @returns the level and phase to carry forward.
 */
function taskPosition(
  state: DeliveryTasksState,
  change: DeliveryChangeMeta,
): { level: DeliveryLevel | null; phase: DeliveryPhase | null } {
  if (change.operation === 'create' || change.operation === 'advance') {
    return { level: change.task.level, phase: change.task.phase }
  }
  if (change.operation === 'clear') return { level: null, phase: null }
  return { level: state.level, phase: state.phase }
}

/**
 * The checklist phase a mirrored todo item belongs to.
 *
 * Todo entries carry no phase, so they inherit the task's current one: a list
 * written while the task is implemented describes implementation work. Phases
 * before implementation collapse into `implemented`, so a mirrored item never
 * claims a phase the task has not reached.
 * @param phase - the task's current lifecycle phase, or null when unknown.
 * @returns the phase to place the mirrored item under.
 */
function mirroredPhase(phase: DeliveryPhase | null): DeliveryPhase {
  if (phase === 'created' || phase === 'designed' || phase === 'specified' || phase === null) {
    return 'implemented'
  }
  return phase
}

/** Trailing `(covers: ...)` / `(覆盖: ...)` annotation on one checklist line. */
const COVERS = /\s*\((?:covers|覆盖)\s*:[^)]*\)\s*$/i

/**
 * Carry the coverage annotation of a recorded item onto its mirrored twin.
 *
 * The annotation is the only place an item declares which verification point it
 * implements, and it lives in the item's own content. A mirrored item is built
 * from a todo entry, which has no annotation to carry, so dropping the
 * recorded one silently erased every declaration the moment a model used both
 * lists — and the task could then never pass verification.
 * @param content - the todo entry's content.
 * @param recorded - items of the checklist the mirror replaces, when there is one.
 * @returns the content, with the matching recorded annotation restored.
 */
function withRecordedCovers(
  content: string,
  recorded: readonly DeliveryTaskItem[] | undefined,
): string {
  if (recorded === undefined) return content
  if (COVERS.test(content)) return content
  const bare = content.trim()
  const match = recorded.find(item => stripCovers(item.content) === bare)
  if (match === undefined) return content
  const annotation = COVERS.exec(match.content.trim())
  return annotation === null ? content : `${bare}${annotation[0].replace(/\s+$/, '')}`
}

/** One checklist line without its trailing coverage annotation. */
function stripCovers(content: string): string {
  return content.trim().replace(COVERS, '').trim()
}

/**
 * Mirror one `todo_write` list into the checklist view.
 *
 * An l1 task drives its work through the lightweight todo list, whose
 * projection is cleared at each turn start. Mirroring here — inside the fold,
 * over an event already in the log — keeps the checklist authoritative for
 * every tier without writing a second event, which `Session.append` refuses to
 * accept from inside a `session/event` callback.
 * @param state - preceding checklist state.
 * @param todos - the whole list the model just wrote.
 * @returns the mirrored state, or the same state when this task does not mirror.
 */
function mirrorTodos(
  state: DeliveryTasksState,
  todos: readonly TodoItem[],
): DeliveryTasksState {
  // Only an l1 task is driven by the todo list: an l0 task owes no checklist,
  // and an l2 task cannot call todo_write at all.
  if (state.level !== 'l1') return state
  if (todos.length === 0) return state
  const recorded = state.current?.source === 'recorded' ? state.current : undefined
  // A recorded l2 checklist is a deliberate statement of the plan, so a later
  // todo list does not overwrite it; the model keeps both in sync itself.
  if (recorded !== undefined && recorded.changeId.length > 0) return state
  const phase = mirroredPhase(state.phase)
  const prior = recorded?.items
  const items: DeliveryTaskItem[] = todos.map(todo => ({
    content: withRecordedCovers(todo.content, prior),
    phase,
    status: todo.status,
  }))
  // A mirrored list is replaced wholesale, exactly like a recorded one, except
  // that each item keeps the coverage annotation its recorded twin declared.
  return {
    ...state,
    current: { changeId: '', items, progress: tasksProgress(items), source: 'mirrored' },
  }
}

/**
 * Apply one session event to the strict checklist fold.
 *
 * Two event types feed this unit: `delivery/tasks` carries a recorded
 * checklist, and `delivery/change` / `todo/write` together let an l1 task's
 * lightweight list stand in for one.
 * @param state - preceding durable checklist state.
 * @param event - next event in sequence order.
 * @returns the next state; a first decode failure is retained and freezes it.
 */
export function applyDeliveryTasksEvent(state: DeliveryTasksState, event: SessionEvent): DeliveryTasksState {
  if (state.failure !== null) return state
  if (event.type === 'delivery/change') {
    const change = event.data as DeliveryChangeMeta
    const position = taskPosition(state, change)
    if (position.level === state.level && position.phase === state.phase) return state
    return { ...state, level: position.level, phase: position.phase }
  }
  if (event.type === 'todo/write') {
    return mirrorTodos(state, event.data.todos)
  }
  if (event.type !== 'delivery/tasks') return state
  try {
    const change = decodeDeliveryTasks(event.data)
    if (change === undefined) return state
    return { ...state, current: tasksView(change), failure: null }
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
    source: zod.enum(['recorded', 'mirrored']),
  }),
  zod.null(),
])

const tasksStateSchema: ZodType<DeliveryTasksState> = zod.object({
  current: tasksViewSchema,
  failure: zod.string().min(1).nullable(),
  level: zod.enum(['l0', 'l1', 'l2']).nullable(),
  phase: zod.enum(PHASE_TUPLE).nullable(),
}).strict()

/** Strict host checklist state exposing per-phase progress to clients. */
export const deliveryTasksProjectionDefinition = {
  key: 'delivery-tasks',
  stateSchema: tasksStateSchema,
  init: (): DeliveryTasksState => ({ current: null, failure: null, level: null, phase: null }),
  apply: applyDeliveryTasksEvent,
  wire: { viewSchema: tasksViewSchema, view: state => state.current },
  stateVersion: 2,
} satisfies ProjectionDefinition<'delivery-tasks', DeliveryTasksState>
