# Agent Note: 分页切出的回合边界不再让该轮缺少用时

Status: implemented

## Problem

轮次底部的用时 pill（`用时 X`）及其弹窗里的首 token 延迟与吞吐，只在客户端已加载窗口同时包含该轮的 `turn/start` 和 `turn/end` 时出现：`TurnTailNodeView` 从 `TurnLocation.start`/`end` 算 `runMs`，而这两个边界只由当前窗口的事件构建。客户端历史按页加载，被切出的边界让 `runMs` 无从计算，于是只有边界完整的那几轮显示用时。

同一排的用量 pill 没有这个问题：它读 host 侧全量折叠的 `turnUsage` 单元，所以每一轮都披露。结果是两个并排的 pill 对分页的敏感度不同——用量每轮都有，用时只有一部分轮次有。

## Decision

新增 `turnTiming` 投影单元，按回合号提供 `runMs`、`ttftMs`、`tokensPerSecond` 与 `peakTokensPerSecond`。它像 `turnUsage` 一样缓冲该轮的轮内事件，在 `turn/end` 时折叠成事实，因此与客户端分页无关。`TurnTailNodeView` 优先读该单元，窗口折叠保留为无单元装配的回退，与用量 pill 的选择顺序逐字对齐。

两个 timing 折叠共用的首 token 判定抽到 `src/chunk-delta.ts`，避免包内出现第二份实现。步内 `llm/retry` 保留该步已记录的首 token，与会话折叠和窗口折叠的语义一致。

## Alternatives considered

**把用时并入 `turnUsage` 单元。** 否决：该单元折叠的是提供方账单（token 桶），墙钟时间与吞吐是另一类事实，合并会让一个单元的 wire 形状同时承担记账与计时两个职责。两个单元各自拥有自己的折叠，客户端按需分别读取。

**扩展 `sessionStats` 携带每轮明细。** 否决：该单元是全会话聚合（统计条消费的八个总计），让它同时输出按回合索引的映射会把两种粒度塞进一个视图，并让统计条的读者承担不需要的负载。

**在客户端缓存全量事件以便自行折叠。** 否决：客户端只持有分页窗口，要让窗口外的事件可用就得把日志重新拉进客户端，这正是 `turnUsage` 单元存在的理由——全量折叠属于 host。

**要求客户端加载全部历史。** 否决：分页是既定的历史加载方式，为了显示一个数字而取消它会把长会话的启动成本转移到每一次打开。

## Consequences

每一轮只要两个边界都落地就披露用时，与用量 pill 的覆盖面一致，两个并排的 pill 不再对分页有不同敏感度。

代价是 host 侧新增一份按轮缓冲的状态：每个进行中的轮次把轮内事件保留到 `turn/end`，与 `turnUsage` 单元的成本形态相同，且同样随会话持久化缓存的状态 schema 一并校验。

客户端保留窗口折叠作为回退，因此不挂载该单元的组合（测试 fixture、独立字典注册表）行为不变。单步回合的峰值仍恒等于平均，这是峰值口径本身的语义，与数据来源无关。

## Testing

- `packages/session/session-stats/tests/turn-timing.spec.ts` 新增 13 条：单步与多步折叠、峰值取最快步、多轮独立、无用量、零解码、步内重试、边界缺失、轮外事件、registry 集成、变更流发布、卸载后移除键、纯函数缺边界的返回。
- `packages/client/ui-chat/tests/chat-view.client.spec.tsx` 新增一条：只加载收尾边界（缺 `turn/start`）时，用时 pill 与弹窗三项仍由 `turnTiming` 披露，锁住"分页切出的轮次不再缺用时"。
- 两个包的测试目录 373 条全部通过；`packages/session/session-stats` 与 `packages/client/ui-chat` 的类型检查零错误。
