/**
 * Durable delivery-task conversation node: folds the `delivery/change` session
 * event family into one keyed Chat node. Each delivery task's `create` opens
 * the node; every later `advance` / `record-*` / `clear` update folds into its
 * state, so the rendered task card follows the task's lifecycle in the
 * conversation timeline — the §6.6 "Conversation node" surface.
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  DeliveryChangeMeta, DeliveryLevel, DeliveryOperation, DeliveryPhase,
} from '@deepseek-ai/dsh-delivery/client'

/** One durable delivery mutation, projected for the timeline card. */
export interface DeliveryTaskEvent {
  readonly seq: number
  readonly time: number
  readonly operation: DeliveryOperation
  /** Phase reached by a create/advance; absent for record/clear. */
  readonly phase?: DeliveryPhase
  /** Record text; absent for create/advance/clear. */
  readonly text?: string
}

/** Final keyed Chat payload for one delivery task. */
export interface DeliveryTaskChatData {
  readonly objective: string
  readonly level: DeliveryLevel
  readonly phase: DeliveryPhase
  readonly changeCount: number
  readonly designCount: number
  readonly specCount: number
  /** Whether the task was cleared (its terminal tombstone was committed). */
  readonly cleared: boolean
  /** Every durable mutation in ascending log order. */
  readonly events: readonly DeliveryTaskEvent[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Durable delivery-discipline task with its phase timeline. */
    'delivery-task': DeliveryTaskChatData
  }
}

/** Fold state accumulated across a task's `delivery/change` events. */
interface DeliveryTaskState {
  readonly objective: string
  readonly level: DeliveryLevel
  readonly phase: DeliveryPhase
  readonly changeCount: number
  readonly designCount: number
  readonly specCount: number
  readonly cleared: boolean
  readonly events: readonly DeliveryTaskEvent[]
}

/** The identity every operation variant carries for the owning task. */
function changeId(data: DeliveryChangeMeta): string {
  switch (data.operation) {
    case 'create':
    case 'advance':
      return String(data.task.id)
    case 'clear':
      return String(data.cleared.id)
    case 'record-change':
    case 'record-design':
    case 'record-spec':
      return String(data.ref.id)
    /* v8 ignore next -- DeliveryOperation is closed and every variant is handled above. */
    default:
      return data satisfies never
  }
}

/** Build one timeline event from a matched `delivery/change` payload. */
function eventOf(seq: number, time: number, data: DeliveryChangeMeta): DeliveryTaskEvent {
  const base = { seq, time, operation: data.operation }
  if (data.operation === 'create' || data.operation === 'advance') {
    return { ...base, phase: data.task.phase }
  }
  if (data.operation === 'record-change' || data.operation === 'record-design'
    || data.operation === 'record-spec') {
    return { ...base, text: data.text }
  }
  return base
}

/** Durable delivery event family folded into one keyed Chat node. */
export const deliveryTaskDefinition: ConversationNodeDefinition<DeliveryTaskState> = {
  kind: 'delivery-task',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'delivery/change') return null
    const role = event.data.operation === 'create' ? 'start' : 'update'
    return { id: changeId(event.data), role }
  },
  start: (_context, match) => {
    if (match.event.type !== 'delivery/change' || match.event.data.operation !== 'create') {
      throw new Error('delivery-task start requires a create delivery change')
    }
    const { task } = match.event.data
    return {
      objective: task.objective,
      level: task.level,
      phase: task.phase,
      changeCount: task.changeCount,
      designCount: task.designCount,
      specCount: task.specCount,
      cleared: false,
      events: [eventOf(match.event.seq, match.event.time, match.event.data)],
    }
  },
  update: (context, match) => {
    if (match.event.type !== 'delivery/change') return context.state
    const state = context.state
    const data = match.event.data
    const events = [...state.events, eventOf(match.event.seq, match.event.time, data)]
    switch (data.operation) {
      case 'advance':
        return { ...state, phase: data.task.phase, events }
      case 'record-change':
        return { ...state, changeCount: data.changeCount, events }
      case 'record-design':
        return { ...state, designCount: data.designCount, events }
      case 'record-spec':
        return { ...state, specCount: data.specCount, events }
      case 'clear':
        return { ...state, cleared: true, events }
      case 'create':
        // A second create for the same id cannot occur in a valid log; keep the
        // current state rather than re-opening the node.
        return state
      /* v8 ignore next -- DeliveryOperation is closed and every variant is handled above. */
      default:
        return data satisfies never
    }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    const state = context.state as DeliveryTaskState
    return {
      key: context.key,
      kind: 'delivery-task',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: {
        objective: state.objective,
        level: state.level,
        phase: state.phase,
        changeCount: state.changeCount,
        designCount: state.designCount,
        specCount: state.specCount,
        cleared: state.cleared,
        events: state.events,
      },
    }
  },
}
