# Agent Note: 会话所选模型与候选池之间的轮询使用

Status: implemented

## Problem

`dsh-llm-failover` 解决的是「限流之后」的问题：请求被限流（`RATE_LIMIT`）时立即换一个候选模型重试。但它不降低限流发生的概率——连续请求仍然集中打向会话所选的同一个模型，只有被打满之后才切走。对密集发起模型请求的 agent（尤其是单个 turn 内多轮 tool 调用），需要一种「限流之前」的主动负载分散手段：让连续请求天然地分摊到多个模型上，从源头降低单一模型被限流的可能性。

## Decision

新增 `@deepseek-ai/dsh-llm-round-robin` 插件，在 `agent/request` 上主动轮换请求路由：

- 配置是一个有序的候选路由列表 `candidates: [{ provider, model }, ...]`（可空；空列表是 no-op）。
- 轮询池是「会话所选模型」锚定、后面跟候选：`[会话所选模型, 候选 1, 候选 2, …]`。候选里与锚点重复的路由在组装池时去重。
- `agent/pre-step` 在每个 step 边界把该 agent 的游标加一；重试不经过 `agent/pre-step`，所以同一逻辑请求的重试沿用本 step 已选定的模型。
- `agent/request`（`prepend`）用 `await next()` 拿到会话所选模型作为锚点，按 `游标 % 池大小` 选中下一个模型：落在锚点上时原样返回，落在候选上时改写路由并清掉锚点的 `reasoningEffort`，让候选解析自己的适配器默认值。

`prepend` 注册保证 `agent/request` 先于 `installModelSelection` 这类在 agent 创建时注册的模型选择监听器运行，让轮询结果成为最终路由。轮询状态是进程内的 `WeakMap<Agent, { cursor }>`，刻意不持久化——一次冷恢复会从当前 step 的锚点重新开始轮换。候选为空时插件直接不注册监听器，是彻底的 no-op。

插件在 `packages/bundle/base/cordis.patch.yml` 中以 `candidates: []` 挂载在 `llm-failover` 之前，并作为 `@deepseek-ai/dsh-base` 的依赖声明。候选路由不做目录成员关系预校验：指向未注册提供方的候选会在轮到时以 `NO_ADAPTER` 大声失败。

## Alternatives considered

**按 turn 轮换而非按 step（方案 B）。** 每个用户轮次换一次模型，轮次内模型稳定、KV Cache 前缀复用更好，但负载分散粒度更粗——一个 turn 内几十次 tool 调用仍集中打向同一模型。按 step 轮换才能最大程度摊薄单模型的请求频率，符合「减少 429」的目标，因此选 step 粒度。

**在 `dsh-llm-failover` 里加一个 `mode` 开关。** 少一个包，但会让一个插件同时承担「被动兜底」和「主动分散」两种职责，配置语义混在一起；且两者的扩展点不同（failover 靠 `agent/request-error`，round-robin 靠 `agent/pre-step` + `agent/request`），拆成独立包更符合「一切皆插件、职责单一」的架构偏好。

**在重试策略里内嵌轮询。** 把候选放进提供方适配器的 `retryPolicy`。但重试策略是提供方作用域、在适配器注册时解析，跨提供方轮询与动态锚点都不自然，因此放弃。

## Consequences

- 收益：连续请求按 step 顺序分摊到「会话所选模型 + 候选」之间，主动降低单一模型被限流的概率；与 `dsh-llm-failover` 互补——round-robin 先主动分散，failover 再对仍被限流的请求被动兜底。
- 代价：同一 turn 内不同 step 会跨模型（能力/风格可能不一致），且切换模型会使重建请求的 KV Cache 前缀与锚点不同，降低前缀复用率；候选路由在加载期不校验，指向失效路由时在轮到时失败而非配置点失败。
- 无新增会话事件，模型可见内容不变——轮询只改请求路由，不改消息。
