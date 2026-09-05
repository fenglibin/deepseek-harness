# Same-session delivery tasks

English | [中文](delivery.zh.md)

One durable change-tracked task per agent session, for the delivery discipline the agent follows while completing a human request. The [goal subsystem](goal.md) covers *continuation* — whether a session may start another round; this page covers *delivery* — whether one piece of work produced a change record and advanced through a disciplined lifecycle. The state lives entirely in the session log, so it survives session resume, fork, and process restarts.

## Identity and lifecycle

`DeliveryTaskId` is a branded id. A caller mutates one exact revision through `DeliveryTaskRef { id, revision }`; every accepted durable mutation increments the revision, so a consumer holding older state receives a clear stale-revision error instead of silently overwriting newer state.

`DeliveryPhase` is the durable lifecycle phase. A task only ever moves forward through the full order `created → designed → specified → implemented → verified → accepted`; the level selects which intermediate phases are required. `DeliveryLevel` is fixed at creation: `l0` runs `created → implemented → verified → accepted`, `l1` adds `designed`, and `l2` adds `designed` and `specified`. Skipping a required phase is rejected at the fold, on replay as much as on the live write.

## The task projection

`DeliverySnapshot` is the durable state: objective, phase, level, and the change, design, and spec counters. `DeliveryView` extends it with the creation and latest-mutation timestamps, and is what `ctx.delivery.get(agent)` returns. The `delivery` projection publishes `DeliveryProjection` — the current snapshot plus those two timestamps — or `null` before the first create and after an accepted task is replaced; `DeliveryProjectionState` carries the strict-replay checkpoint behind it, including the first replay failure.

## Durable events

`delivery/change` is the session event carrying every mutation: a full snapshot for `create` and `advance`, an incremental record for `record-change`, `record-design`, and `record-spec`, or a clear tombstone. `delivery/changed` is the Host-side notification emitted after one durable mutation commits; it is agent-scoped, so a listener registered for one agent never sees another agent's task.

## Service behavior

[`DeliveryService`](../../packages/delivery/delivery/src/index.ts) creates, advances, records against, and clears one task per session, and registers the `delivery` projection unit on startup; a composition without the projection registry cannot activate `ctx.delivery`. It enforces the phase order and compare-and-set identity but not policy: when a task advances, whether a change record is required, and how strong a gate the model sees belong to [`dsh-tool-delivery`](../../packages/delivery/tool-delivery/README.md). The package [README](../../packages/delivery/delivery/README.md) defines the callable API and the durable error codes.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdelivery--deliveryservice"></a>

### `ctx.delivery` — `DeliveryService`

Delivery task service (`ctx.delivery`) backed exclusively by the owning session log.

```ts cordis-catalog
/**
 * Read the current task for one exact live agent.
 * @param agent - owning live agent.
 * @returns a fresh view or `undefined` when no task is current.
 * @throws {@link DeliveryError} when the agent is not the registry's live instance.
 */
get(agent: Agent): DeliveryView | undefined

/**
 * Create a task in the `created` phase. An accepted task may be replaced;
 * every other current phase must be cleared or advanced first.
 * @param agent - owning live agent.
 * @param request - objective and optional level.
 * @returns the created live view.
 */
create(agent: Agent, request: CreateDeliveryRequest): DeliveryView

/**
 * Advance the current task to the given phase. The phase must be the single
 * legal next phase for the task's level; skipping a required phase is
 * rejected before anything is committed.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @param phase - target phase.
 * @returns the advanced view.
 */
advance(agent: Agent, ref: DeliveryTaskRef, phase: DeliveryPhase): DeliveryView

/**
 * Record one change against the current task without changing its phase.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @param text - non-empty change description.
 * @returns the view with the incremented change count.
 */
recordChange(agent: Agent, ref: DeliveryTaskRef, text: string): DeliveryView

/**
 * Record one design against the current task without changing its phase.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @param text - non-empty design description.
 * @returns the view with the incremented design count.
 */
recordDesign(agent: Agent, ref: DeliveryTaskRef, text: string): DeliveryView

/**
 * Record one spec against the current task without changing its phase.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @param text - non-empty spec description.
 * @returns the view with the incremented spec count.
 */
recordSpec(agent: Agent, ref: DeliveryTaskRef, text: string): DeliveryView

/**
 * Clear the current task while retaining a durable tombstone and history.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the tombstone ref whose revision is one past the cleared snapshot.
 */
clear(agent: Agent, ref: DeliveryTaskRef): DeliveryTaskRef
```

Types: [Agent](core.md)

Source: [`packages/delivery/delivery/src/index.ts`](../../packages/delivery/delivery/src/index.ts)

<a id="delivery-events"></a>

### `delivery/*` events

<a id="deliverychanged--emit"></a>

#### `delivery/changed` — emit

Delivery mutation accepted by one live agent. The matching `delivery/change` session event has already committed. Listener failures are contained. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
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
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/delivery/delivery/src/domain.ts`](../../packages/delivery/delivery/src/domain.ts)
<!-- END GENERATED cordis-surface -->
