# Agent Note: 轮次用时面板显示输出峰值速度

Status: implemented

## Problem

轮次用时面板只显示本轮总用时、输出速度（TPS）与首 token 用时（TTFT）。输出速度是本轮所有已计费步骤的合计比值（`Σ outputTokens ÷ Σ decodeMs`），一次长步骤会把一次短步骤的高速率平均掉，读者看不出本轮模型最快跑到多少。

## Decision

`deriveTurnMetrics` 折叠每个 turn 时额外记录 `peakTokensPerSecond`：对该 turn 内每个同时具备 decode 墙钟与 provider 上报输出 token 的步骤，算一次 `outputTokens ÷ (decodeMs / 1000)`，取最大值。该值经 `TurnTailChatData` 与 `TurnTimePanelProps` 透传到用时面板，作为「输出峰值速度（TPS）」一行，排在输出速度之后、首 token 用时之前。

峰值与平均共用同一口径（provider 上报 token ÷ decode 墙钟），因此两者可比。decode 墙钟为 0 的步骤不产生比值，被排除在峰值之外；所有步骤的 decode 墙钟都为 0 时不输出峰值行。非零比值必然使合计 decode 墙钟大于零，所以峰值只与平均速度一同出现。

## Alternatives considered

**按 chunk 到达时间做滑动窗口取峰值。** 否决：chunk 时间戳能从日志精确重建（chunk-row 用 `dt` 间隔数组无损保留成员时间），但 chunk 不携带 token 计数——provider 只在步骤级上报 `outputTokens`。按字符数估算 token 会让这个数字与旁边的平均速度不同口径，且滑动窗口大小、小 chunk 抖动、reasoning 与 tool-call 增量是否计入都需另行决策。投入是步骤级峰值的数倍，换来一个不可比的估算值。

**把三个速率指标移入「本轮用量」面板。** 否决：TTFT 与输出速度已归属用时面板，重复展示会让同一事实有两个出处。峰值与它们同类，归入同一面板。

**新增 host 侧 per-turn 时序投影，按分页安全口径计算峰值。** 当时否决：现有 TTFT 与平均速度同样走客户端窗口口径，为峰值单独引入 host 投影会让同面板三个指标口径不一。该否决随后被推翻——分页切出的回合边界会让整轮缺少用时，[turnTiming 单元](../bug-fix/2026-09-11-turn-timing-paged-out-boundaries.zh.md)改为让三者一起走全量日志。

## Consequences

单步骤 turn 的峰值恒等于平均速度：该 turn 只有一次模型调用，没有第二个步骤可供比较。多步骤 turn（发生工具调用）才可能出现峰值高于平均。这是所选口径的固有语义。

峰值与同面板的 TTFT、平均速度同源：三者都由 `turnTiming` 单元按全量日志披露，见[分页切出的回合边界不再让该轮缺少用时](../bug-fix/2026-09-11-turn-timing-paged-out-boundaries.zh.md)。

## Testing

- `turn-metrics.client.spec.ts` 新增三条用例：峰值取最快步骤而非最后一步、单步骤 turn 峰值等于平均、全部步骤 decode 墙钟为 0 时不输出峰值；三条既有全等断言同步补上 `peakTokensPerSecond`。该文件 15 条通过。
- `turn-usage-panel.client.spec.tsx` 断言用时面板渲染「输出峰值速度（TPS）35 tok/s」，并断言未记录时该行不出现。该文件 6 条通过。
- `packages/client/ui-chat/tests` 全目录 329 条通过。
- `apps/web/tests/turn-tail-actions.e2e.ts` 的用时弹窗断言由一条 tok/s 行改为两条（平均与峰值），使 e2e 与新实现一致。
