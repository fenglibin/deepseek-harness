/**
 * Host-side vocabulary of the delivery domain: live views and the scoped
 * `delivery/changed` event. The durable change payloads, replay fold, and
 * error codes now live in ./types.ts (the pure client-safe outlet) so client
 * aggregates can read `delivery/change` event data without pulling dsh-agent,
 * dsh-llm, or cordis into the program — the one-program-per-side layout
 * forbids that. This file re-exports them for host consumers and keeps the
 * host-only `delivery/changed` scoped event declaration here.
 * @module @deepseek-ai/dsh-delivery
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DeliveryOperation, DeliveryTaskRef, DeliveryView } from './types.ts'

/** Live notification after one durable delivery mutation commits. */
export interface DeliveryChanged {
  readonly operation: DeliveryOperation
  readonly ref: DeliveryTaskRef
  /** Absent for a clear tombstone. */
  readonly task?: DeliveryView
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Delivery mutation accepted by one live agent. The matching
     * `delivery/change` session event has already committed. Listener failures
     * are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`):
     * agent-scoped listeners receive only that agent.
     * @param payload.agent - agent whose session owns the task.
     * @param payload.change - fresh current projection or clear tombstone.
     * @mode emit
     */
    'delivery/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: DeliveryChanged }): void
  }
}
