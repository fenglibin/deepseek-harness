/** Durable model-selection intent and request-use projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type {
  ModelSelection,
  ModelSelectionProjection,
  ModelSelectionProjectionState,
} from './types.ts'

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) as unknown as z.ZodType<ModelSelection>

const modelSelectionProjectionStateSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  pending: modelSelectionSchema.nullable(),
  chosen: modelSelectionSchema.nullable(),
}) as unknown as z.ZodType<ModelSelectionProjectionState>

const modelSelectionProjectionSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  next: modelSelectionSchema.nullable(),
}) as unknown as z.ZodType<ModelSelectionProjection>

/**
 * Advance durable model-selection state by one Session event.
 * @param state - selection state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced selection state.
 */
function applyModelSelectionProjection(
  state: ModelSelectionProjectionState,
  event: SessionEvent,
): ModelSelectionProjectionState {
  if (event.type === 'model/selection') {
    return sameSelection(state.pending, event.data) && sameSelection(state.chosen, event.data)
      ? state
      : { lastUsed: state.lastUsed, pending: event.data, chosen: event.data }
  }
  if (event.type !== 'request/header') return state
  const config = event.data.header.config
  const lastUsed: ModelSelection = {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(config.reasoningEffort) }),
  }
  const pending = sameSelection(state.pending, lastUsed) ? null : state.pending
  // The first request header (`reason: 'initial'`) records the session's model —
  // the deployment default, or the user's authored choice. Later reroute
  // headers (failover/round-robin, `reason: 'change'`) must not displace it,
  // so `chosen` is only advanced on the initial header, with an
  // adapter-defaulted reasoning effort dropped (it is not a conversation
  // choice).
  const chosen = event.data.reason === 'initial'
    ? {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined || event.data.header.adapterDefaults?.reasoningEffort === true
        ? {}
        : { reasoningEffort: String(config.reasoningEffort) }),
    }
    : state.chosen
  return sameSelection(state.lastUsed, lastUsed) && pending === state.pending && sameSelection(state.chosen, chosen)
    ? state
    : { lastUsed, pending, chosen }
}

const modelSelectionProjection = {
  key: 'modelSelection',
  stateSchema: modelSelectionProjectionStateSchema,
  init: () => ({ lastUsed: null, pending: null, chosen: null }),
  apply: applyModelSelectionProjection,
  wire: {
    viewSchema: modelSelectionProjectionSchema,
    // `next` is the authored choice only: pending then chosen. It deliberately
    // omits lastUsed so a request served by a rerouted (failover/round-robin)
    // candidate never reads as the session's model; a null next lets the
    // consumer fall back to the deployment default.
    view: state => ({ lastUsed: state.lastUsed, next: state.pending ?? state.chosen }),
  },
  stateVersion: 3,
} satisfies ProjectionDefinition<'modelSelection', ModelSelectionProjectionState>

function sameSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort)
}

/**
 * Register the durable model-selection projection when the registry is present.
 * @param ctx - Session Controller context.
 */
export function installModelSelectionProjection(ctx: Context): void {
  ctx.sessionProjections.register(modelSelectionProjection)
}
