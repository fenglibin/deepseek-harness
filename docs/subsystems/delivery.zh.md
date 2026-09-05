# 同会话交付任务

[English](delivery.md) | 中文

每个 agent 会话持有一份持久的、可追溯变更的任务，用于 agent 在完成一次人类请求时所遵循的交付纪律。[goal 子系统](goal.zh.md)覆盖**续跑**——一个会话是否可以开始下一轮；本页覆盖**交付**——一件工作是否产出了变更记录，并走完了一条有纪律的生命周期。状态完全存放在会话日志中，因此它能经受会话恢复、fork 与进程重启。

## 身份与生命周期

`DeliveryTaskId` 是一个 branded id。调用方通过 `DeliveryTaskRef { id, revision }` 变更某一个确切修订；每次被接受的持久变更都会递增修订号，因此持有较旧状态的消费者会收到明确的过期修订错误，而不是静默覆盖更新的状态。

`DeliveryPhase` 是持久的生命周期阶段。任务只能沿完整顺序 `created → designed → specified → implemented → verified → accepted` 向前移动；等级决定哪些中间阶段是必需的。`DeliveryLevel` 在创建时固定：`l0` 走 `created → implemented → verified → accepted`，`l1` 增加 `designed`，`l2` 再增加 `specified`。跳过必需阶段会被 fold 拒绝，重放时与实时写入时一样。

## 任务投影

`DeliverySnapshot` 是持久状态：目标、阶段、等级，以及变更、设计与规格三个计数器。`DeliveryView` 在其之上加上创建时间与最近一次变更时间，正是 `ctx.delivery.get(agent)` 的返回。`delivery` 投影发布 `DeliveryProjection`——当前快照加上这两个时间戳——或在首次创建之前、以及一个已接受任务被替换之后发布 `null`；`DeliveryProjectionState` 承载其背后的严格重放检查点，包括首次重放失败。

## 持久事件

`delivery/change` 是承载每次变更的会话事件：`create` 与 `advance` 携带完整快照，`record-change`、`record-design` 与 `record-spec` 携带增量记录，`clear` 则携带一个墓碑。`delivery/changed` 是在一次持久变更提交后发出的 Host 侧通知；它按 agent 划定作用域，因此为某个 agent 注册的监听器绝不会看到另一个 agent 的任务。

## 服务行为

[`DeliveryService`](../../packages/delivery/delivery/src/index.ts) 为每个会话创建、推进、记录并清除一份任务，并在启动时注册 `delivery` 投影单元；缺少投影注册表的组装无法激活 `ctx.delivery`。它强制执行阶段顺序与比较并设置式身份，但不决定策略：任务何时推进、是否必须有变更记录，以及模型看到多强的门禁，都属于 [`dsh-tool-delivery`](../../packages/delivery/tool-delivery/README.zh.md)。该包 [README](../../packages/delivery/delivery/README.zh.md) 定义了可调用 API 与持久错误码。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

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

Types: [Agent](core.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/delivery/delivery/src/domain.ts`](../../packages/delivery/delivery/src/domain.ts)
<!-- END GENERATED cordis-surface -->
