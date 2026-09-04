/**
 * Pure types of the delivery-discipline domain: the ONE home of the
 * `delivery` projection-key declaration plus the durable payload vocabulary
 * it carries, free of host-side imports (cordis events, dsh-agent, dsh-llm,
 * the service). `./types` serves host consumers; `./client` re-exports it for
 * client aggregates with zero duplication.
 *
 * @module @deepseek-ai/dsh-delivery/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one delivery task across its durable revisions. */
export type DeliveryTaskId = Branded<'DeliveryTaskId'>

/** Compare-and-set identity for one exact task revision. */
export interface DeliveryTaskRef {
  /** Stable task identity. */
  readonly id: DeliveryTaskId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/**
 * The delivery lifecycle phase. A task may only advance forward through the
 * full order; the level selects which intermediate phases are required.
 */
export type DeliveryPhase =
  | 'created'
  | 'designed'
  | 'specified'
  | 'implemented'
  | 'verified'
  | 'accepted'

/**
 * Task-size class selected at creation (or by an explicit override).
 * L0 is a small fix; L1 adds a design phase; L2 adds an openspec split.
 */
export type DeliveryLevel = 'l0' | 'l1' | 'l2'

/** Full durable state written by every non-clear delivery mutation. */
export interface DeliverySnapshot extends DeliveryTaskRef {
  /** Human-requested task objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: DeliveryPhase
  /** Task-size class; fixed for the task's lifetime. */
  readonly level: DeliveryLevel
  /** Number of change records committed for this task so far. */
  readonly changeCount: number
  /** Number of design records committed for this task so far. */
  readonly designCount: number
  /** Number of spec records committed for this task so far. */
  readonly specCount: number
}

/** Current task projection, including values derived from the session log. */
export interface DeliveryView extends DeliverySnapshot {
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
}

/**
 * The `delivery` projection value: the current durable task with its replay
 * counters, or `null` before the first create and after the task is accepted
 * and replaced.
 */
export interface DeliveryProjection {
  /** Current durable task snapshot (the CAS ref for mutations rides on it). */
  readonly task: DeliverySnapshot
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
}

/** Strict checkpoint state used to derive the current task client value. */
export interface DeliveryProjectionState {
  /** Latest valid current task, or null before creation and after acceptance. */
  readonly current: DeliveryProjection | null
  /** Task identities already created in this Session, retained to reject reuse. */
  readonly seenTaskIds: DeliveryTaskId[]
  /** First strict replay failure, or null while the durable stream is valid. */
  readonly failure: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    delivery: DeliveryProjectionState
  }
  interface SessionProjectionMap {
    /**
     * The session's current delivery task, or `null` before the first create
     * and after the task is accepted and replaced.
     */
    delivery: DeliveryProjection | null
  }
}

/** Delivery state-changing verbs recorded in the durable source change. */
export type DeliveryOperation =
  | 'create'
  | 'advance'
  | 'record-change'
  | 'record-design'
  | 'record-spec'
  | 'clear'

/** Full-snapshot task mutation committed by a durable `delivery/change` event. */
export interface DeliverySnapshotChangeMeta {
  readonly kind: 'delivery/change'
  readonly version: 1
  readonly operation: 'create' | 'advance'
  readonly task: DeliverySnapshot
  readonly createdAt: number
  readonly updatedAt: number
}

/** Incremental change record committed without changing the task phase. */
export interface DeliveryRecordChangeMeta {
  readonly kind: 'delivery/change'
  readonly version: 1
  readonly operation: 'record-change'
  readonly ref: DeliveryTaskRef
  /** Non-empty change description. */
  readonly text: string
  /** Post-increment change count for the current task. */
  readonly changeCount: number
  readonly updatedAt: number
}

/** Incremental design record committed without changing the task phase. */
export interface DeliveryRecordDesignMeta {
  readonly kind: 'delivery/change'
  readonly version: 1
  readonly operation: 'record-design'
  readonly ref: DeliveryTaskRef
  /** Non-empty design description. */
  readonly text: string
  /** Post-increment design count for the current task. */
  readonly designCount: number
  readonly updatedAt: number
}

/** Incremental spec record committed without changing the task phase. */
export interface DeliveryRecordSpecMeta {
  readonly kind: 'delivery/change'
  readonly version: 1
  readonly operation: 'record-spec'
  readonly ref: DeliveryTaskRef
  /** Non-empty spec description. */
  readonly text: string
  /** Post-increment spec count for the current task. */
  readonly specCount: number
  readonly updatedAt: number
}

/** Tombstone retained when the current task is cleared. */
export interface DeliveryClearChangeMeta {
  readonly kind: 'delivery/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: DeliveryTaskRef
  readonly clearedAt: number
}

/** Durable change union carried by the delivery domain's own session event. */
export type DeliveryChangeMeta =
  | DeliverySnapshotChangeMeta
  | DeliveryRecordChangeMeta
  | DeliveryRecordDesignMeta
  | DeliveryRecordSpecMeta
  | DeliveryClearChangeMeta

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete post-mutation task state, an incremental change record, or a
     * clear tombstone.
     */
    'delivery/change': DeliveryChangeMeta
  }
}

/** Pure replay fold of durable delivery facts. */
export interface FoldedDelivery {
  /** Current task, absent after a clear or before the first create. */
  readonly task?: DeliverySnapshot
  /** Current task creation time, absent without a current task. */
  readonly createdAt?: number
  /** Current task mutation time, absent without a current task. */
  readonly updatedAt?: number
  /** Latest mutation ref, including a clear tombstone. */
  readonly lastRef?: DeliveryTaskRef
}

/** Stable error codes for rejected delivery reads and mutations. */
export type DeliveryErrorCode =
  | 'DELIVERY_AGENT_NOT_LIVE'
  | 'DELIVERY_TASK_NOT_FOUND'
  | 'DELIVERY_ALREADY_EXISTS'
  | 'DELIVERY_STALE_REVISION'
  | 'DELIVERY_INVALID_OBJECTIVE'
  | 'DELIVERY_INVALID_LEVEL'
  | 'DELIVERY_INVALID_PHASE'
  | 'DELIVERY_INVALID_CHANGE_TEXT'
  | 'DELIVERY_INVALID_DESIGN_TEXT'
  | 'DELIVERY_INVALID_SPEC_TEXT'
  | 'DELIVERY_INVALID_TRANSITION'
