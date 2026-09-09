## ADDED Requirements

### Requirement: 需求分析前置
任务 SHALL 在创建后先完成需求分析与对齐，完成前 SHALL 拒绝写设计文档，完成状态 SHALL 可追溯。

#### Scenario: 需求分析完成前拒绝设计文档
- **WHEN** 当前任务的 `analysisDone` 为 false 且模型调用 `record_design`
- **THEN** 系统 SHALL 在 `stateful` 档返回 blocking 错误，`advisory` 档注入提醒

#### Scenario: 需求分析完成可追溯
- **WHEN** 模型调用 `mark_analysis_done`
- **THEN** 系统 SHALL 提交 `mark-analyzed` 操作，任务快照的 `analysisDone` SHALL 变为 true，且可从 session log 重建

### Requirement: 任务清单三态与统一持久化
任务清单项 SHALL 以三态 status 表达进度，非 l2 任务 SHALL 通过 record_tasks 落盘任务清单。

#### Scenario: 任务项三态状态
- **WHEN** 记录任务清单
- **THEN** 每个任务项 SHALL 携带 `status` 三态（pending/in_progress/completed）

#### Scenario: 非 l2 任务清单持久化
- **WHEN** 非 l2 任务调用 `record_tasks`
- **THEN** 系统 SHALL 接受空 change_id 并将清单持久化到 delivery-tasks 投影

### Requirement: 进度语义化呈现
左侧进度栏 SHALL 按「需求分析/设计文档/任务列表/实现验证」分组展示，并默认展开实时更新。

#### Scenario: 进度栏语义分组展示
- **WHEN** 会话存在当前交付任务
- **THEN** 卡片 SHALL 展示需求分析、任务列表、实现验证，l1/l2 额外展示设计文档

#### Scenario: 进度实时更新默认展开
- **WHEN** 任务进度变化
- **THEN** 卡片 SHALL 默认展开并随投影实时更新各分组状态

### Requirement: 验证分级
非 l2 任务 SHALL 依据任务清单验证，l2 任务 SHALL 依据设计文档与 openspec 任务列表验证。

#### Scenario: 非 l2 验证清单全完成
- **WHEN** 非 l2 任务推进到 verified
- **THEN** 系统 SHALL 校验 delivery-tasks 清单全部 completed，未完成则 blocking 并列出差异
