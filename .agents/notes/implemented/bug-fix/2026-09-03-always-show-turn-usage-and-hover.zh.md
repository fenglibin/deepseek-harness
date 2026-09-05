# Agent Note：Turn 尾部始终披露用量与用时，弹层 hover 展开、展示缓存命中率，且运行计时不再重置

状态：已实现

## 问题

已完成的 Turn 尾部只有在 token-meter fold 能证明精确总量时才披露用量。`deriveTurnTokenUsage` 只有在用量样本带 `totalTokens`，或同时带 `cacheReadTokens` 与 `cacheWriteTokens` 时才关闭一次 attempt；DeepSeek 不回报 cache-write 分桶，且 adapter 开始产出 `totalTokens` 之前录制的会话都会导致 fold 失败。被中断（用户停止或系统中止）的 Turn，一旦某个 attempt 在没有用量样本时关闭，就会丢弃所有已计费 attempt，因此多 step 被中止的 Turn 只显示 `用时 …` 而没有 `用量 … tok` pill。另外两个统计弹层原本只能点击展开，缓存命中率也只有在每个 attempt 都回报 `cacheReadTokens` 时才出现，运行中的"深度求索"计时在 `turn/start` 不在加载窗口时会退回组件挂载时间，导致切换会话再切回来时计时重新开始。

## 决定

`normalizeUsage` 在 provider 省略 `totalTokens` 时，把精确总量推导为计费 prompt 加 output（`inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`），并把缺失的缓存分桶视为 0——这与累积的 `tokenUsage` projection 采用的约定一致。回报了用量样本的 attempt 仍须以安全计数与精确总量关闭，但在回报任何用量前就被中断的 attempt 被跳过，因此 Turn 中其余已计费 attempt 仍会披露。用量与用时 pill 对每个 fold 携带计费 attempt 的已完成 Turn 都渲染。用量与用时弹层在 hover（mouse enter）时展开，离开后经过指针宽限关闭；点击保留给键盘与触屏。用量弹层始终展示缓存命中率（`cacheReadTokens ?? 0`）。运行计时锚定 `turn/start`；当该边界不在窗口内时没有稳定锚点，因此省略计时而非从挂载时间重新开始。

## 备选方案

**保留点击展开弹层。** 否决：弹层是用户 hover 查看的诊断面板，点击只是多加一步而不增加精度。

**保留缓存命中行的条件渲染。** 否决：会话级 StatsLine 已始终展示缓存命中率，per-Turn 弹层省略它属于无解释的不对称。

**保留"精确总量"要求。** 否决：没有 cache-write 分桶的 provider 恰好按 `input + cacheRead + output` 计费，把缺失分桶视为 0 是完整账单而非下界。

**任一 attempt 被中断就让整轮失效。** 否决：用户停止或瞬时失败仍应披露已计费的 attempt；只有矛盾的用量样本（而非缺失）才使 fold 失效。

**在 `turn/start` 不在窗口内时把运行计时锚定到挂载时间。** 否决：挂载时间在每次重进时重置，导致计时重新开始；在真实耗时未知时省略计时更诚实。

## 影响

`deriveTurnTokenUsage` 现在为省略 `totalTokens` 和/或 `cacheWriteTokens` 的 provider 推导总量，并在某一步被中断时保留已计费 attempt，因此 turn-tail 用量 pill 会出现在此前静默的会话上（包括至少有一个计费 attempt 的中止/失败 Turn）。hover 展开/关闭与始终展示的缓存命中率通过共享的 `useStatDialog` 同时作用于用量与用时两个 pill。运行中的"深度求索"计时不再在会话重进时重启：它锚定 `turn/start`，并在该边界被分页移出时省略。以带用量但无 `totalTokens` 的 turn 播种、或中断某一步的 keyless 录制会话 golden 现在会显示 `用量 … tok` pill，须用 `pnpm run test:web:refresh` 重新生成。
