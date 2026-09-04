/** Package-owned durable delivery-stream invariants. @module @deepseek-ai/dsh-delivery/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { applyDeliveryEvent, emptyDeliveryFoldState } from './fold.ts'
import type { DeliveryFoldState } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-delivery'

/** Cordis companion plugin name. */
export const name = 'delivery-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Copy the independent fold before validating one candidate event. */
function cloneState(state: DeliveryFoldState): DeliveryFoldState {
  return {
    task: state.task,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastRef: state.lastRef,
    seenTaskIds: new Set(state.seenTaskIds),
  }
}

/** Apply one event through the strict delivery decoder and attribute failures. */
function applyChecked(state: DeliveryFoldState, event: SessionEvent, fail: InvariantFailure): void {
  try {
    applyDeliveryEvent(state, event)
  } catch (error) {
    /* v8 ignore next -- the strict delivery decoder throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    fail(`session event ${event.seq} violates the durable delivery stream: ${message}`)
  }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, DeliveryFoldState>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: DeliveryFoldState }>()

  const seed = (session: Session): DeliveryFoldState => {
    const state = emptyDeliveryFoldState()
    for (const event of session.events) applyChecked(state, event, fail)
    states.set(session, state)
    return state
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): DeliveryFoldState => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const state = cloneState(stateFor(session))
    applyChecked(state, event, fail)
    staged.set(event, { session, state })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching delivery-fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the delivery-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
