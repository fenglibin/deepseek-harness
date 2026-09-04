/**
 * Same-session delivery-discipline domain: event-sourced task state,
 * compare-and-set mutations, and forward-only phase transitions.
 * @module @deepseek-ai/dsh-delivery
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  applyDeliveryEvent,
  nextDeliveryPhase,
} from './fold.ts'
import type { DeliveryFoldState } from './fold.ts'
import {
  DELIVERY_CHANGE_VERSION,
  DeliveryError,
  DeliveryTaskId,
} from './runtime.ts'
import type {
  DeliveryChangeMeta,
  DeliveryClearChangeMeta,
  DeliveryLevel,
  DeliveryOperation,
  DeliveryPhase,
  DeliveryProjection,
  DeliveryProjectionState,
  DeliverySnapshot,
  DeliverySnapshotChangeMeta,
  DeliveryTaskRef,
  DeliveryView,
} from './types.ts'
import type { DeliveryChanged } from './domain.ts'

// The pure payload outlet (./types.ts, ONE home of the `delivery`
// projection-key declaration) re-exported onto the package root keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionStateMap merge.
export type * from './types.ts'
export type * from './domain.ts'
export { DELIVERY_CHANGE_VERSION, DeliveryError, DeliveryTaskId } from './runtime.ts'
export { decodeDeliveryChange, foldDelivery, nextDeliveryPhase } from './fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    delivery: DeliveryService
  }
}

/** Wire payload schema of the `delivery` projection (current task or cleared null). */
const deliveryProjectionSchema: ZodType<DeliveryProjection | null> = zod.union([
  zod.object({
    task: zod.object({
      id: zod.string().min(1),
      revision: zod.number().int().positive(),
      objective: zod.string().min(1),
      phase: zod.union([
        zod.literal('created'),
        zod.literal('designed'),
        zod.literal('specified'),
        zod.literal('implemented'),
        zod.literal('verified'),
        zod.literal('accepted'),
      ]),
      level: zod.union([zod.literal('l0'), zod.literal('l1'), zod.literal('l2')]),
      changeCount: zod.number().int().nonnegative(),
      designCount: zod.number().int().nonnegative(),
      specCount: zod.number().int().nonnegative(),
    }),
    createdAt: zod.number(),
    updatedAt: zod.number(),
  }),
  zod.null(),
]) as ZodType<DeliveryProjection | null>

const deliveryProjectionStateSchema: ZodType<DeliveryProjectionState> = zod.object({
  current: deliveryProjectionSchema,
  seenTaskIds: zod.array(zod.string().min(1)).refine(
    ids => new Set(ids).size === ids.length,
    { message: 'seen task ids must be unique' },
  ),
  failure: zod.string().min(1).nullable(),
}).strict().superRefine((state, context) => {
  if (state.current === null) return
  if (!state.seenTaskIds.includes(state.current.task.id)) {
    context.addIssue({ code: 'custom', message: 'current task id must be retained among seen task ids' })
  }
  if (state.current.updatedAt < state.current.createdAt) {
    context.addIssue({ code: 'custom', message: 'current task update cannot precede its creation' })
  }
}) as unknown as ZodType<DeliveryProjectionState>

/** Build strict fold state from one checkpoint-safe projection state. */
function deliveryFoldState(state: DeliveryProjectionState): DeliveryFoldState {
  return {
    task: state.current?.task,
    createdAt: state.current?.createdAt,
    updatedAt: state.current?.updatedAt,
    lastRef: undefined,
    seenTaskIds: new Set(state.seenTaskIds),
  }
}

/** Convert strict fold state into checkpoint-safe projection state. */
function deliveryProjectionState(state: DeliveryFoldState): DeliveryProjectionState {
  let current: DeliveryProjection | null = null
  if (state.task !== undefined) {
    const { createdAt, updatedAt } = state
    /* v8 ignore next 2 -- the fold always writes timestamps with the current task, and delivery has no message-only branch */
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error('current task fold lacks timestamps')
    }
    current = {
      task: state.task,
      createdAt,
      updatedAt,
    }
  }
  return {
    current,
    seenTaskIds: [...state.seenTaskIds],
    failure: null,
  }
}

/**
 * Fold durable delivery events through the strict replay rules without
 * throwing from the projection registry's event drive. The first invalid
 * owned event is retained in `failure`; host delivery access rejects that
 * state while the client view remains at the last valid task.
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is unrelated).
 */
export function applyDeliveryProjection(state: DeliveryProjectionState, event: SessionEvent): DeliveryProjectionState {
  if (state.failure !== null) return state
  if (event.type !== 'delivery/change') return state
  const folded = deliveryFoldState(state)
  try {
    applyDeliveryEvent(folded, event)
    return deliveryProjectionState(folded)
  } catch (error: unknown) {
    /* v8 ignore next -- the strict delivery fold throws Error instances. */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `delivery replay failed at session event ${event.seq}: ${message}` }
  }
}

/** Strict host delivery state with the existing cropped client value. */
export const deliveryProjectionDefinition = {
  key: 'delivery',
  stateSchema: deliveryProjectionStateSchema,
  init: (): DeliveryProjectionState => ({ current: null, seenTaskIds: [], failure: null }),
  apply: applyDeliveryProjection,
  wire: { viewSchema: deliveryProjectionSchema, view: state => state.current },
  stateVersion: 1,
} satisfies ProjectionDefinition<'delivery', DeliveryProjectionState>

/** Input whose omitted level defaults to L0. */
export interface CreateDeliveryRequest {
  readonly objective: string
  readonly level?: DeliveryLevel
}

/** Validate and normalize an objective at the domain boundary. */
function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DeliveryError('delivery objective must be a non-empty string', 'DELIVERY_INVALID_OBJECTIVE')
  }
  return value.trim()
}

/** Validate and normalize a task level. */
function resolveLevel(value: unknown): DeliveryLevel {
  if (value !== 'l0' && value !== 'l1' && value !== 'l2') {
    throw new DeliveryError('delivery level must be l0, l1, or l2', 'DELIVERY_INVALID_LEVEL')
  }
  return value
}

/** Delivery task service (`ctx.delivery`) backed exclusively by the owning session log. */
export class DeliveryService extends Service {
  static inject = ['agents', 'sessionProjections']

  constructor(ctx: Context) {
    super(ctx, 'delivery')
    ctx.sessionProjections.register(deliveryProjectionDefinition)
  }

  /**
   * Read the current task for one exact live agent.
   * @param agent - owning live agent.
   * @returns a fresh view or `undefined` when no task is current.
   * @throws {@link DeliveryError} when the agent is not the registry's live instance.
   */
  get(agent: Agent): DeliveryView | undefined {
    this.assertLive(agent)
    return this.view(this.state(agent.session))
  }

  /**
   * Create a task in the `created` phase. An accepted task may be replaced;
   * every other current phase must be cleared or advanced first.
   * @param agent - owning live agent.
   * @param request - objective and optional level.
   * @returns the created live view.
   */
  create(agent: Agent, request: CreateDeliveryRequest): DeliveryView {
    const objective = resolveObjective(request.objective)
    const level = request.level === undefined ? 'l0' : resolveLevel(request.level)
    this.assertLive(agent)
    const current = this.state(agent.session)
    if (current !== null && current.task.phase !== 'accepted') {
      throw new DeliveryError(
        `delivery task "${current.task.id}" already exists with phase "${current.task.phase}"`,
        'DELIVERY_ALREADY_EXISTS',
      )
    }
    const now = Date.now()
    const task: DeliverySnapshot = {
      id: DeliveryTaskId(`task-${randomUUID()}`),
      revision: 1,
      objective,
      phase: 'created',
      level,
      changeCount: 0,
      designCount: 0,
      specCount: 0,
    }
    return this.commitSnapshot(agent, 'create', task, now, now)
  }

  /**
   * Advance the current task to the given phase. The phase must be the single
   * legal next phase for the task's level; skipping a required phase is
   * rejected before anything is committed.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param phase - target phase.
   * @returns the advanced view.
   */
  advance(agent: Agent, ref: DeliveryTaskRef, phase: DeliveryPhase): DeliveryView {
    const currentState = this.expectCurrent(agent, ref)
    const current = currentState.task
    const expected = nextDeliveryPhase(current.level, current.phase)
    if (expected !== phase) {
      throw new DeliveryError(
        `cannot advance task "${current.id}" from phase "${current.phase}" to "${phase}" at level "${current.level}"; expected "${expected ?? 'none'}"`,
        'DELIVERY_INVALID_TRANSITION',
      )
    }
    const next: DeliverySnapshot = {
      ...current,
      revision: current.revision + 1,
      phase,
    }
    return this.commitSnapshot(agent, 'advance', next, currentState.createdAt, this.nextMutationTime(currentState))
  }

  /**
   * Record one change against the current task without changing its phase.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param text - non-empty change description.
   * @returns the view with the incremented change count.
   */
  recordChange(agent: Agent, ref: DeliveryTaskRef, text: string): DeliveryView {
    const currentState = this.expectCurrent(agent, ref)
    const current = currentState.task
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new DeliveryError('delivery change text must be a non-empty string', 'DELIVERY_INVALID_CHANGE_TEXT')
    }
    const change: DeliveryChangeMeta = {
      kind: 'delivery/change',
      version: DELIVERY_CHANGE_VERSION,
      operation: 'record-change',
      ref: { id: current.id, revision: current.revision + 1 },
      text: text.trim(),
      changeCount: current.changeCount + 1,
      updatedAt: this.nextMutationTime(currentState),
    }
    this.commit(agent, change)
    return this.view(this.state(agent.session)) as DeliveryView
  }

  /**
   * Record one design against the current task without changing its phase.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param text - non-empty design description.
   * @returns the view with the incremented design count.
   */
  recordDesign(agent: Agent, ref: DeliveryTaskRef, text: string): DeliveryView {
    const currentState = this.expectCurrent(agent, ref)
    const current = currentState.task
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new DeliveryError('delivery design text must be a non-empty string', 'DELIVERY_INVALID_DESIGN_TEXT')
    }
    const change: DeliveryChangeMeta = {
      kind: 'delivery/change',
      version: DELIVERY_CHANGE_VERSION,
      operation: 'record-design',
      ref: { id: current.id, revision: current.revision + 1 },
      text: text.trim(),
      designCount: current.designCount + 1,
      updatedAt: this.nextMutationTime(currentState),
    }
    this.commit(agent, change)
    return this.view(this.state(agent.session)) as DeliveryView
  }

  /**
   * Record one spec against the current task without changing its phase.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param text - non-empty spec description.
   * @returns the view with the incremented spec count.
   */
  recordSpec(agent: Agent, ref: DeliveryTaskRef, text: string): DeliveryView {
    const currentState = this.expectCurrent(agent, ref)
    const current = currentState.task
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new DeliveryError('delivery spec text must be a non-empty string', 'DELIVERY_INVALID_SPEC_TEXT')
    }
    const change: DeliveryChangeMeta = {
      kind: 'delivery/change',
      version: DELIVERY_CHANGE_VERSION,
      operation: 'record-spec',
      ref: { id: current.id, revision: current.revision + 1 },
      text: text.trim(),
      specCount: current.specCount + 1,
      updatedAt: this.nextMutationTime(currentState),
    }
    this.commit(agent, change)
    return this.view(this.state(agent.session)) as DeliveryView
  }

  /**
   * Clear the current task while retaining a durable tombstone and history.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the tombstone ref whose revision is one past the cleared snapshot.
   */
  clear(agent: Agent, ref: DeliveryTaskRef): DeliveryTaskRef {
    const currentState = this.expectCurrent(agent, ref)
    const current = currentState.task
    const tombstone: DeliveryTaskRef = { id: current.id, revision: current.revision + 1 }
    const change: DeliveryClearChangeMeta = {
      kind: 'delivery/change',
      version: DELIVERY_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: this.nextMutationTime(currentState),
    }
    this.commit(agent, change)
    return { ...tombstone }
  }

  /** Reject stale or missing current-state refs. */
  private expectCurrent(agent: Agent, ref: DeliveryTaskRef): DeliveryProjection {
    this.assertLive(agent)
    const state = this.state(agent.session)
    if (state === null) throw new DeliveryError('no current delivery task', 'DELIVERY_TASK_NOT_FOUND')
    const current = state.task
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new DeliveryError(
        `stale delivery ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'DELIVERY_STALE_REVISION',
      )
    }
    return state
  }

  /** Enforce exact live-agent identity rather than trusting a matching id. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new DeliveryError(`agent "${agent.id}" is not live in this registry`, 'DELIVERY_AGENT_NOT_LIVE')
    }
  }

  /** Read the current durable projection maintained by the registry. */
  private state(session: Session): DeliveryProjection | null {
    const state = this.ctx.sessionProjections.stateOf(session, 'delivery')
    /* v8 ignore next -- the service registers its own projection before any state read */
    if (state === undefined) throw new Error('delivery projection is not registered')
    if (state.failure !== null) throw new Error(state.failure)
    return state.current
  }

  /** Clamp a current task's next timestamp across backward wall-clock movement. */
  private nextMutationTime(state: DeliveryProjection): number {
    return Math.max(Date.now(), state.updatedAt)
  }

  /** Build and commit one full-snapshot mutation. */
  private commitSnapshot(
    agent: Agent,
    operation: Extract<DeliveryOperation, 'create' | 'advance'>,
    task: DeliverySnapshot,
    createdAt: number,
    updatedAt: number,
  ): DeliveryView {
    const change: DeliverySnapshotChangeMeta = {
      kind: 'delivery/change',
      version: DELIVERY_CHANGE_VERSION,
      operation,
      task,
      createdAt,
      updatedAt,
    }
    this.commit(agent, change)
    return this.view(this.state(agent.session)) as DeliveryView
  }

  /** Commit one mutation into the delivery log and live event stream. */
  private commit(agent: Agent, change: DeliveryChangeMeta): void {
    const ref = change.operation === 'clear'
      ? change.cleared
      : change.operation === 'record-change' || change.operation === 'record-design'
        || change.operation === 'record-spec'
        ? change.ref
        : { id: change.task.id, revision: change.task.revision }
    agent.session.append('delivery/change', change)
    const view = this.view(this.state(agent.session))
    const notification: DeliveryChanged = {
      operation: change.operation,
      ref: { ...ref },
      ...view === undefined ? {} : { task: view },
    }
    agentEvents(this.ctx, agent).emit('delivery/changed', { change: notification })
  }

  /** Build a detached current view. */
  private view(state: DeliveryProjection | null): DeliveryView | undefined {
    if (state === null) return undefined
    return {
      ...state.task,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    }
  }
}

export default DeliveryService
