# Agent Note: 交付纪律需求分析与进度呈现

Status: implemented

## 问题

交付纪律在「任务创建」与「设计文档」之间缺少「需求分析与对齐」环节：任务经 `agent/pre-step` 自动创建后，模型按 system prompt 指引直接写设计文档，跳过向用户澄清需求、对齐边界的过程。左侧悬浮卡片只渲染六个生命周期阶段的跑马灯，不呈现需求分析、设计、任务拆分、验证这些有业务意义的进度，且默认折叠。非 `l2` 任务的工作分解由 `todo_write` 承担，其列表在 `turn/start` 清空，既无法跨轮作为进度依据，也没有任何逐点验证。

## 决策

- **需求分析前置。** `DeliverySnapshot` 新增 `analysisDone: boolean`（默认 `false`），`DeliveryOperation` 新增 `mark-analyzed` 变体；`DeliveryService.markAnalyzed(agent, ref)` 提交它，工具层新增 `mark_analysis_done`。`record_design` 在 `analysisDone === false` 时按 enforcement 档返回 blocking 或提醒，因此需求分析完成前无法写设计文档。旧事件无该键时按 `false` 折叠。
- **任务清单三态。** `DeliveryTaskItem.done: boolean` 改为 `status: 'pending' | 'in_progress' | 'completed'`，`delivery-tasks` 投影的 `progress` 只把 `completed` 计为完成。`l2` 的 `tasks.md` checkbox 映射为 `- [x]`→`completed`、`- [ ]`→`pending`。
- **非 `l2` 统一落盘。** `record_tasks` 的 `change_id` 对非 `l2` 允许空串（`l2` 仍强制 kebab-case），`checklistMismatch` 对空 change id 跳过磁盘核对。`todo_write` 仅作当轮临时清单。
- **进度语义化。** `DeliveryFloatCard` 重构为「需求分析 / 设计文档 / 任务列表 / 实现验证」四组，随投影实时更新；`l0` 省略设计文档组。该卡片的默认可见性、设计文档链接与 `todos` 回落由[交付分级复核范围与悬浮卡片可用性](2026-09-15-delivery-grading-review-and-float-card-visibility.zh.md)持有。
- **验证分级。** `l2` 维持 coverage 与 validate；非 `l2` 推进到 `verified` 时校验清单全部 `completed`，未完成则 blocking 并列出差异。

## 备选方案

**新增 `analyzed` 阶段。** 否决：改动面大（fold/类型/UI/快照全动），而用户诉求只需一个可 gate 的布尔标记，`mark-analyzed` 操作即可承载。

**复用 `record_change` 标记分析完成。** 否决：让 `record_change` 承担两件无关职责，gate 语义隐晦。

## 后果

- **获得** 需求分析成为程序化前置环节，进度栏以语义分组呈现整体完成状态，非 `l2` 也有基于清单的逐点验证。
- **代价** `delivery` 投影快照新增 `analysisDone` 字段（旧事件回放按 `false` 折叠）；任务清单项由二态改为三态，`checklistMismatch` 的磁盘核对随之适配；模型需多一次 `mark_analysis_done` 与 `record_tasks` 调用。
- **延后** 门禁通过/失败与验收结果的时间线节点。
