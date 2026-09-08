# Agent Note: 按锚点模型限定轮询与故障转移的 `when` 过滤

Status: implemented

## Problem

[`dsh-llm-round-robin`](2026-09-08-llm-round-robin.zh.md) 与 [`dsh-llm-failover`](2026-09-08-rate-limit-failover.zh.md) 默认对**所有**会话所选模型生效：只要配了 `candidates`，任何锚点模型都会参与轮换，任何锚点模型被限流都会触发故障转移。当一个部署同时挂载多个模型路由、但只想给其中某个主模型配候选时（例如只给昂贵或易限流的模型做负载分散/兜底），现有配置无法按模型限定生效范围。

## Decision

给两个插件都新增一个可选配置 `when: [{ provider, model }, ...]`：

- `when` 是一个有序的提供方／模型路由列表（可空）。
- 留空（`[]` 或省略）时规则适用于所有锚点模型，与旧行为完全一致。
- 列出路由时，规则仅对命中的锚点（会话所选）模型生效。
- 判定一律以「会话所选模型」为锚点，两插件语义对称：

  - **round-robin**：在 `agent/request` 里解析出锚点后先做 `matchesWhen` 判断，不在 `when` 中则原样返回、不轮换。
  - **failover**：在 `agent/request`（无挂起候选）时用锚点计算 `armed` 标志；`agent/request-error` 仅当 `armed` 为真才发起故障转移。`armed` 在整个 step 内保持，`agent/pre-step` 时复位——因此一旦主模型（在 `when` 中）触发故障转移，候选也限流时仍继续轮换到下一个候选，而不是半途退回等待。

- 校验与 `candidates` 一致：条目需非空 `provider`／`model`、列表内去重（重复报 `duplicate when route`）。
- `packages/bundle/base/cordis.patch.yml` 中两个插件默认挂载 `when: []`。

## Alternatives considered

**在 `agent/request-error` 用当前路由（`state.current`）判定 `when`。** failover 一旦换到候选，候选再被限流时会因候选不在 `when` 中而停止轮换、退回固定等待，导致故障转移半途而废。改用「锚点武装标志」（`armed`）保证主模型触发故障转移后，候选也限流时仍继续轮换。

**做成「模型级候选开关」的可视化 UI。** 更贴合用户在设置页的心智模型，但需要改 `ui-settings-models` 的 UI、新增 settings namespace 与 wire 协议透传，工作量比纯配置大一个数量级。先做配置驱动的 `when`，UI 包装留作后续。

**只给 failover 加、round-robin 不加。** 两者都以会话所选模型为锚点、语义对称，单独加一个会让「按模型限定」的配置心智不统一，因此同时落地。

## Consequences

- 收益：部署可按主模型精确限定轮询／故障转移的生效范围，未列出的模型完全不受影响；空 `when` 完全向后兼容。
- 代价：多了一个配置维度；`when` 匹配是 `provider` + `model` 的精确相等，不做通配或前缀匹配。
- 无新增会话事件，模型可见内容不变——过滤只决定「是否改写请求路由」，不改消息。
