## Why

交付纪律在「任务创建」与「设计文档」之间缺少「需求分析与对齐」环节。任务经 `agent/pre-step` 自动创建后，模型按 system prompt 指引直接写设计文档，跳过向用户澄清需求、对齐边界的过程。左侧悬浮卡片只渲染六个生命周期阶段的跑马灯，不呈现需求分析、设计、任务拆分、验证这些有业务意义的进度，且默认折叠。非 `l2` 任务的工作分解由 `todo_write` 承担，其列表在 `turn/start` 清空，既无法跨轮作为进度依据，也没有任何逐点验证。

## What Changes

- 任务快照新增 `analysisDone` 标记，新增 `mark-analyzed` 操作与 `mark_analysis_done` 工具；`record_design` 在需求分析完成前被程序拦截。
- `DeliveryTaskItem.done` 布尔改为 `status` 三态（`pending`/`in_progress`/`completed`），非 `l2` 也通过 `record_tasks` 落盘任务清单，`todo_write` 仅作当轮临时清单。
- 左侧悬浮卡片重构为「需求分析 / 设计文档 / 任务列表 / 实现验证」四组语义进度，实时更新、默认展开。
- 验证分级：`l2` 维持 coverage 与 validate；非 `l2` 推进到 `verified` 时校验清单全部完成。
