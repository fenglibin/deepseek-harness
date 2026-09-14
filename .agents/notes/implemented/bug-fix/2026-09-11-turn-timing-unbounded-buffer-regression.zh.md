# Agent Note: turnTiming 投影重新引入了 turnUsage 已修掉的无界事件缓冲

Status: implemented

## Problem

`turnTiming` 投影单元（`packages/session/session-stats/src/turn-timing.ts`）用 `buffer: SessionEvent[]` 累积一个进行中回合从 `turn/start` 到 `turn/end` 的每一个事件，`apply` 里 `buffer: [...state.buffer, event]` 每事件复制整段数组。这正是 `2026-09-11-unbounded-projection-checkpoint-and-heap-snapshot-stall` 里 `turnUsage` 被修掉的同一个反模式：回合可以横跨整段会话，状态既无界又是 O(n²)。

`turnUsage` 的修复把状态改成增量折叠（一个 `TurnUsageFold`，按 step 增长），并在 `turn-usage-projection.ts` 的模块注释里把"状态必须随步数而非事件数增长"写成硬要求。`turnTiming` 在同一个提交簇里新增，却仍用原始事件缓冲，于是同一份检查点文档再次可能装下整段会话的日志。

## Decision

`turnTiming` 改为增量折叠，与 `turnUsage` 同构。状态只保留四项：`turnStart`（该轮 `turn/start` 时间）、`steps`（已关闭的 step，每条一个 `StepTiming`）、`open`（当前打开的 step）、`turns`（已结算的轮条目）。`step/start` 关闭前一个 step 并打开新的，`assistant/chunk` 记录首 token，`assistant/message` 记录解码完成；`turn/end` 时把 step 事实折叠成 `runMs`/`ttftMs`/`tokensPerSecond`/`peakTokensPerSecond` 并丢弃 step 状态。计算逻辑抽成 `settleTurnTiming`，整段参考折叠 `deriveTurnTiming` 复用同一份实现，两个读者不再分叉。

`stateVersion` 从 1 升到 2，旧缓存行按既有规则在读取时被丢弃而不是迁移。

## Why the turnUsage fix did not catch this

`turnUsage` 的修复只约束了它自己这一个单元：`turn-usage-projection.ts` 的注释写的是"这是本单元的硬要求"，没有上升为所有投影单元的通用不变式。`turnTiming` 是独立新增的单元，作者按"与 `turnUsage` 成本形态相同"去写——而那时 `turnUsage` 的成本形态本身已经被改成增量的了，`turnTiming` 复制的是它修复前的那一版。

## Consequences

收益：`turnTiming` 的检查点状态从"随事件数增长"降到"随步数增长"，一个长回合（几万事件）的检查点文档从整段日志缩到每个 step 一条边界事实，`structuredClone` 与序列化成本同步消失。代价：`stateVersion` 升到 2 让所有既有 `turnTiming` 缓存行失效，每个会话的下一次冷读多折叠一次尾部——与 `turnUsage` 升版时同样的、毫秒级的代价。

## Testing

- `packages/session/session-stats/tests/turn-timing.spec.ts` 新增两条：一条用 5000 个流式 `assistant/chunk` 事件但仅一个 step 的回合，断言折叠后 `JSON.stringify(state)` 小于 1,000 字节（锁住"状态随步数而非事件数增长"）；一条跨两回合断言增量折叠的每个条目等于整段参考折叠 `deriveTurnTiming` 的对应切片（锁住两套折叠的等价性）。
- 既有 13 条用例不变地全绿，它们是这次重写的等价性证据。
- `packages/session/session-stats/tests/turn-timing.spec.ts` 15 条通过；该包 `tsc -b` 零错误。
