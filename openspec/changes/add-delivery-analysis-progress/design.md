## Context

[方案文档](../../../docs/design/delivery-discipline-analysis-progress-rationale.zh.md) 已对齐三个决策：`l1` 保留设计文档、`analysisDone` 布尔标记、非 `l2` 统一走 `record_tasks`。本节记录实现层面的决策。

## Decision

### D1 需求分析标记与设置入口

任务快照增加 `analysisDone: boolean`（默认 `false`），严格 decoder 字段白名单同步。新增 `DeliveryOperation` 变体 `mark-analyzed`，其 durable 事件携带 `ref` 与 `analysisDone: true`，fold 校验只能由 `false` 变 `true`。`DeliveryService` 新增 `markAnalyzed(agent, ref)`。工具层新增 `mark_analysis_done`，`record_design` 在其前置检查 `analysisDone === false` 时按 enforcement 档返回 blocking 或提醒。

### D2 任务清单三态与 record_tasks 扩展

`DeliveryTaskItem.done: boolean` 改为 `status: 'pending' | 'in_progress' | 'completed'`。`delivery-tasks` 投影的 items 与 schema 同步三态，`progress` 按 `status === 'completed'` 计数。`l2` 的 `tasks.md` checkbox 映射为 `- [x]`→`completed`、`- [ ]`→`pending`。`record_tasks` 的 `change_id` 对非 `l2` 允许空串，`l2` 仍强制 kebab-case。

### D3 进度语义化呈现

`DeliveryFloatCard` 重构为四组：需求分析（`analysisDone`）、设计文档（`l1`/`l2`，`designCount`/phase）、任务列表（`delivery-tasks` items）、实现验证（phase 位置）。卡片默认展开，随投影实时更新。

### D4 验证分级

`l2` 维持 coverage gap 检查、`openspec validate --strict` 与 `postHooks`。非 `l2` 推进到 `verified` 时校验 `delivery-tasks` 清单全部 `completed`，未完成则 blocking 并列出差异。

## Consequences

- `analysisDone` 为新字段，旧事件无此键时按默认 `false` 折叠，`delivery` 投影 stateVersion 递增。
- 三态改造需同步调整 `checklistMismatch` 的磁盘 checkbox 对比与既有快照。
- 非 `l2` 走 `record_tasks` 增加一次模型调用，以 `enforcement: advisory` 与空清单直接推进为出口。
