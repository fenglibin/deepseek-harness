# 交付纪律需求分析与进度呈现优化方案

> 状态：决策已对齐，待实施
> 目标读者：维护者与决策者
> 关联诉求：把「需求分析/对齐」前置为任务的第一环节，重构左侧进度栏为语义化细粒度进度，并按任务级别用不同的任务源做验证。
> 关联文档：[交付纪律方案](delivery-discipline-rationale.zh.md)、[openspec 拆分与双进度方案](delivery-discipline-openspec-split-rationale.zh.md)、[自动触发方案](delivery-discipline-auto-trigger-rationale.zh.md)

---

## 1. 背景与动机

交付纪律当前在「任务创建」与「设计文档」之间缺少「需求分析与对齐」环节。任务一经 `agent/pre-step` 自动创建，模型即按 system prompt 指引直接写设计文档，跳过向用户澄清需求、对齐边界的过程。左侧悬浮卡片只渲染六个生命周期阶段的跑马灯，不呈现需求分析、设计、任务拆分、验证这些对用户有实际意义的进度，且默认折叠，用户无法实时感知任务整体完成状态。

## 2. 目标

- **需求分析前置**：任务创建后先完成需求分析与对齐，确认后再写设计文档；`record_design` 在分析完成前被程序拦截。
- **进度语义化**：左侧进度栏按「需求分析 / 设计文档 / 任务列表 / 实现验证」分组，任务逐项展示状态，实时更新、默认展开。
- **验证分级**：`l2` 依据设计文档与 openspec 任务列表验证；非 `l2` 依据任务清单（`record_tasks` 落盘）验证。
- **任务清单统一持久化**：非 `l2` 也通过 `record_tasks` 落盘任务清单，`todo_write` 仅作当轮临时工作清单，消除跨轮丢失。

## 3. 非目标

- 不改变 `agent-loop` 本身（遵循「Plugins, not loop changes」）。
- 不重做规模分级判定，不改变 `l0/l1/l2` 的阶段顺序语义（`l1` 仍保留 `designed` 阶段）。
- 不改变 openspec 的原生目录布局与 validate 接入方式。
- 不判断实现是否语义正确；验证校验的是「清单是否完成」与「命令是否全绿」这类机器证据。

## 4. 现状分析

### 4.1 阶段与分级

阶段状态机由 `LEVEL_PHASES` 固定：`l0` 走 `created→implemented→verified→accepted`，`l1` 走 `created→designed→implemented→verified→accepted`，`l2` 走 `created→designed→specified→implemented→verified→accepted`。`created` 的语义仅为「任务已创建」，没有表达「需求是否已分析对齐」。

### 4.2 设计文档写入

`record_design` 工具把一条设计追加到 `.dsh/design/<task-id>.md`，只受 `gateAdvance` 的「推进到 `designed` 需 `designCount ≥ 1`」约束，写入动作本身不检查任何前置条件。`l2` 另有 `record_spec(kind: 'design')` 写 `openspec/changes/<change-id>/design.md`。

### 4.3 任务清单

`l2` 的任务清单由 `record_spec(kind: 'tasks')` 写 `tasks.md`，再经 `record_tasks` 上报为 `delivery-tasks` 投影的 `items`（`content`/`phase`/`done`，`done` 为布尔二态）。非 `l2` 用 `todo_write`，其 `todos` 投影在 `turn/start` 时清空，无法跨轮作为进度与验证依据。

### 4.4 进度呈现

[`DeliveryFloatCard`](../../packages/client/ui-delivery/src/client/DeliveryFloatCard.tsx) 读 `delivery` 与 `delivery-tasks` 投影，折叠时显示分级徽标、阶段与 objective，展开后显示阶段进度条、`nextGate` 提示与产物路径。它没有任何子任务维度，也不区分需求分析、设计、验证这些语义阶段，默认折叠。

### 4.5 验证

`l2` 在推进到 `verified` 时做 coverage gap 检查，推进到 `accepted` 时跑 `openspec validate` 与 `postHooks`。非 `l2` 没有任何逐点验证：`todo_write` 勾完与否无程序校验。

## 5. 方案对比与选型

### 5.1 「需求分析完成」的设置机制

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 新增 `mark-analyzed` 操作 + 工具（选定） | 任务快照加 `analysisDone` 布尔，新增一个 durable 操作把它置真，配套 `mark_analysis_done` 工具 | 语义清晰、可硬性 gate、可追溯；需扩展 `DeliveryOperation` 与 fold |
| B. 复用 `record_change` 加参数 | 在记录变更时带 `mark_analysis_done: true` 顺带置位 | 改动小，但让 `record_change` 承担两件无关职责，gate 语义隐晦 |
| C. 复用 `advance` 加 `analysisDone` 目标 | 不新增 phase，仅在 advance 时置位 | 与「不加 phase」的决策相悖，且 `advance` 的 phase 枚举不含该语义 |

### 5.2 任务项状态：二态还是三态

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 保持 `done` 二态 | 沿用 `done: boolean` | 无法表达「进行中」，与进度栏三态需求冲突 |
| B. 改为 `status` 三态（选定） | `pending`/`in_progress`/`completed`，与 `todo` 对齐 | 需改 `DeliveryTaskItem`、`delivery-tasks` 投影与 `checklistMismatch` 对比逻辑，改动面中等 |

### 5.3 非 `l2` 的 `change_id`

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 置空（选定） | 非 `l2` 无 openspec change，`change_id` 记空串，`DeliveryTasksView.changeId` 允许空 | 语义直接，`l2` 仍要求 kebab-case 不变 |
| B. 用 `task_id` 顶替 | 以 `task-<uuid>` 充当 change id | 违反 openspec 的 kebab-case 语法，污染既有校验 |

## 6. 推荐方案详解

### 6.1 需求分析标记（决策 1）

`DeliverySnapshot` 增加 `analysisDone: boolean`（默认 `false`），严格 decoder 的字段白名单同步更新。新增 `DeliveryOperation` 变体 `'mark-analyzed'`，其 durable 事件为 `delivery/change` 的 `mark-analyzed` operation，携带 `ref` 与 `analysisDone: true`；fold 校验 `analysisDone` 只能由 `false` 变 `true`。`DeliveryService` 新增 `markAnalyzed(agent, ref)` 方法。

工具层新增 `mark_analysis_done`，模型在需求澄清、对齐完成后调用。`record_design` 的 `execute` 增加前置检查：`analysisDone === false` 时，`stateful` 档返回 blocking 错误 `DELIVERY_GATE_BLOCKED`（附提示「先完成需求分析再写设计」），`advisory` 档注入提醒。

### 6.2 任务清单三态与 `record_tasks` 扩展（决策 2、3）

`DeliveryTaskItem` 的 `done: boolean` 改为 `status: 'pending' | 'in_progress' | 'completed'`。`delivery-tasks` 投影的 `items` 与 `tasksViewSchema` 同步为三态；`progress` 聚合逻辑改为按 `status === 'completed'` 计数。`l2` 的 `tasks.md` checkbox 映射为：`- [x]`→`completed`、`- [ ]`→`pending`，`checklistMismatch` 的磁盘对比据此调整。

`record_tasks` 扩展到非 `l2`：`change_id` 对非 `l2` 允许空串（`l2` 仍强制 kebab-case），`items` 携带 `status` 三态。非 `l2` 任务因此与 `l2` 共享 `delivery-tasks` 投影作为唯一持久化任务源，`todo_write` 仅作当轮临时清单，不再承载跨轮进度。

### 6.3 进度栏语义化呈现

`DeliveryFloatCard` 重构为「需求分析 / 设计文档 / 任务列表 / 实现验证」四组，数据派生如下：

| 进度项 | 展示条件 | 状态派生 |
|---|---|---|
| 需求分析 | 所有级别 | `analysisDone` 为真→已完成，否则→进行中 |
| 设计文档 | `l1`/`l2` | `designCount > 0` 或 phase 已过 `designed`→已完成，否则→编写中 |
| 任务列表 | 所有级别 | `items` 为空→待拆分；否则逐项渲染，`status`→待实现/进行中/已完成 |
| 实现验证 | 所有级别 | phase 早于 `implemented`→待实现，等于 `implemented`→进行中，晚于→已完成 |

任务列表在 `l2` 与 `l1` 均读取 `delivery-tasks` 投影，数据源单一；`l2` 的清单来自 openspec 拆分，非 `l2` 来自 `record_tasks` 上报。卡片默认展开，进度随 `delivery` 与 `delivery-tasks` 投影实时更新，无需额外交互。

### 6.4 验证依据分级

- `l2`：维持现有 coverage gap 检查、`openspec validate --strict` 与 `postHooks`。
- 非 `l2`：推进到 `verified` 时，程序检查 `delivery-tasks` 清单是否全部 `completed`；存在未完成项则 blocking 并列出差异，`advisory` 档仅提醒。推进到 `accepted` 时仍跑 `postHooks`（若有）。

## 7. 分阶段实施批次

| 批次 | 内容 | 验收标志 |
|---|---|---|
| A1 | 领域层：`analysisDone` 字段 + `mark-analyzed` 操作 + `DeliveryService.markAnalyzed` + fold 严格校验 | 快照可带 `analysisDone`；`markAnalyzed` 置位后 replay 正确；非法迁移被拒 |
| A2 | 工具层：`mark_analysis_done` 工具 + `record_design` 前置 gate + `record_tasks` 三态扩展与 `change_id` 空值 | 分析完成前 `record_design` 被拒；非 `l2` 可落三态清单 |
| A3 | 验证层：非 `l2` 推进 `verified` 时校验清单全部 `completed` | 未完成清单阻挡推进并列出差异 |
| A4 | UI 层：`DeliveryFloatCard` 四组语义化重构 + 默认展开 + locales 文案 | 进度栏按四组展示、实时更新、默认展开 |
| A5 | 文档与快照：包 README、`doc-sync`、Agent Note、录制会话快照 | 门禁通过 |

**交付门禁**：每批进入下一批前执行编译（`pnpm run typecheck`）与本次变更触及 package 的单测，失败项只允许减少、不允许新增。

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| `analysisDone` 字段破坏严格回放 | 旧 session 无法回放 | 字段为新增、旧事件无此键时按默认 `false` 折叠；`delivery` 投影 `stateVersion` 递增 |
| `record_design` 硬拦截卡住探索 | 模型无法在设计前写任何记录 | `advisory` 档仅提醒；`stateful` 档拦截信息指明「先完成需求分析」 |
| 三态改造破坏 `l2` 的 `checklistMismatch` 对比 | 推进 `implemented` 误判 | 对比逻辑随三态调整，单测覆盖二态磁盘 checkbox 到三态的映射 |
| 非 `l2` 强制走 `record_tasks` 增加模型调用 | 简单任务被拉长 | 非 `l2` 仍可空清单直接推进；`enforcement: advisory` 下仅提醒 |
| 进度栏默认展开占用纵向空间 | 长任务列表挤占会话 | 任务列表项按需滚动；卡片仍可手动折叠 |

**回滚**：A1–A4 位于 delivery 包族与 `ui-delivery`，`enabled: false` 或卸载插件即移除；不修改 `agent-loop`，不改动既有 `delivery/change` 既有 operation 的字段集合。

## 9. 已确认决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | `l1` 设计文档去留 | 保留：`l1` 仍写 `.dsh/design`，进度栏 `l1` 也展示「设计文档」项 |
| 2 | 「需求分析完成」落地方式 | 任务快照加 `analysisDone` 布尔标记，`record_design` gate 检查它 |
| 3 | 非 `l2` 任务列表数据源 | 统一走 `record_tasks`（`delivery-tasks` 投影持久化），`todo_write` 仅当轮临时清单 |
| 4 | `analysisDone` 设置机制 | 新增 `mark-analyzed` 操作 + `mark_analysis_done` 工具 |
| 5 | 任务项状态 | `DeliveryTaskItem.done` 二态改为 `status` 三态（`pending`/`in_progress`/`completed`） |
| 6 | 非 `l2` 的 `change_id` | 置空；`l2` 仍要求 kebab-case |
