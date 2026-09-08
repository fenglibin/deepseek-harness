# Agent Note: 限流时的候选模型故障转移

Status: implemented

## Problem

模型请求被提供方限流（HTTP 429，规范化为 `RATE_LIMIT`）时，`dsh-llm-retry` 会等待固定的 `rateLimitDelayMs`（默认 30 秒）再重试。等待能保证下一次尝试落在配额窗口之外，但当部署里还有其它可用模型时，等待是纯浪费：任务本可以立即换一个模型重试，而不是每次都干等。

## Decision

新增 `@deepseek-ai/dsh-llm-failover` 插件，在 `agent/request-error` 上先于 `dsh-llm-retry` 运行：

- 配置是一个有序的候选路由列表 `candidates: [{ provider, model }, ...]`（可空；空列表是 no-op）。
- 请求因 `RATE_LIMIT` 失败时，把当前路由加入本步骤的 `tried` 集合，选出第一个尚未尝试的候选，记为挂起路由并立即返回 `{ kind: 'retry' }`（短路掉下游重试执行器的固定等待）。
- `agent/request` 把挂起路由应用到下一次请求配置、把候选标记为已尝试，并清掉旧路由的 `reasoningEffort` 让候选解析自己的默认值；候选无论随后以限流还是其它错误失败，都不会在本步骤内被重复选中。
- 全部候选都尝试过之后，调用 `next()` 把失败转交给 `dsh-llm-retry`，恢复原来的 30 秒等待。
- 每个 step 在 `agent/pre-step` 清空 `tried`，因此下一个 step 的限流会重新从候选列表头开始轮换。

两个关键顺序保证都用 `prepend` 注册实现：`agent/request-error` 上先于重试执行器运行；`agent/request` 上先于 `installModelSelection` 这类在 agent 创建时注册的模型选择监听器运行，让候选路由成为最终路由。故障转移状态是进程内的 `WeakMap<Agent, …>`，刻意不持久化——一次冷恢复会从当前 step 开头重新轮换，与「每个 step 是一次独立周期」的语义一致。

插件在 `packages/bundle/base/cordis.patch.yml` 中以 `candidates: []` 挂载在 `llm-retry` 之前，并作为 `@deepseek-ai/dsh-base` 的依赖声明。候选路由不做目录成员关系预校验：指向未注册提供方的候选会在使用时以 `NO_ADAPTER` 大声失败。

## Alternatives considered

**在「设置 → 模型」页面给每个模型加「候选」开关（方案 B）。** 更贴合用户在 UI 上的心智模型，但需要改 `ui-settings-models` 的 UI、新增 settings namespace 与 wire 协议透传，工作量比纯配置大一个数量级。本方案选择先做配置驱动的 MVP，UI 包装留作后续；两者共享同一份 `candidates` 数据，UI 只是多一个可视化编辑入口。

**扩展 `RequestErrorAction` 携带替换配置。** 让 `agent/request-error` 直接返回 `{ kind: 'retry', config }` 并由 loop 应用，语义最直接，但需要改动 `agent-loop` 与 `dsh-agent` 的类型，违反「加插件，不改 loop」的偏好。本方案用两个 `prepend` 的 agent 扩展点达成同样的效果，loop 零改动。

**在重试策略里内嵌候选列表。** 把候选放进提供方适配器的 `retryPolicy`。但重试策略是提供方作用域、在适配器注册时解析，跨提供方故障转移与动态路由都不自然，因此放弃。

## Consequences

- 收益：限流时任务立即换候选模型重试，不再每次都等 30 秒；全部候选也都限流时才退回固定等待，行为与改动前一致。
- 代价：每个 step 只按顺序尝试每个候选一次，之后退回纯等待重试（不重复轮换）；候选路由在加载期不校验，指向失效路由时在使用点失败而非配置点失败。
- 无新增会话事件，模型可见内容不变——故障转移只改请求路由，不改消息。
