## MODIFIED Requirements

### Requirement: 分级复核覆盖 l0 与 l1
交付自动分级 SHALL 只在程序化评分判定为 `l2` 时自动创建任务；判定为 `l0` 或 `l1` 时 SHALL 把分级判据交给模型，由模型决定是否创建任务及其级别。

#### Scenario: 中弱信号不自动建任务
- **WHEN** 直接人类请求经程序化评分判为 `l1`（单个中等信号或两个弱信号）
- **THEN** 系统 SHALL NOT 自动创建交付任务，SHALL 注入一次分级判据提示

#### Scenario: 强信号仍自动建 l2
- **WHEN** 直接人类请求命中强信号或超过字符上限
- **THEN** 系统 SHALL 自动创建 `l2` 交付任务，且不注入分级判据提示

### Requirement: 非 l2 也需确认需求并落盘清单
非 `l2` 交付任务 SHALL 同样先与用户确认需求、标记需求分析完成，并通过 `record_tasks` 落盘任务清单。

#### Scenario: 指引要求非 l2 落盘清单
- **WHEN** 模型读取交付工具的指引与 `record_tasks` 的工具描述
- **THEN** 文案 SHALL 要求非 `l2` 任务先确认需求、调用 `mark_analysis_done`，并用空 `change_id` 的 `record_tasks` 落盘清单，`todo_write` 仅作当轮临时清单

## ADDED Requirements

### Requirement: 设计文档进度可点击打开
悬浮卡片的「设计文档」组在状态为已完成时 SHALL 提供可点击的文件链接，点击后经宿主机打开设计文档；打开失败 SHALL 就地提示。

#### Scenario: 设计文档已完成时提供链接
- **WHEN** 当前任务存在设计记录
- **THEN** 卡片 SHALL 在「设计文档」状态文本后渲染一个指向 `.dsh/design/<task-id>.md` 的按钮

#### Scenario: 打开失败就地提示
- **WHEN** 用户点击该链接且宿主机拒绝打开
- **THEN** 卡片 SHALL 就地显示失败原因，且不影响卡片其它内容

### Requirement: 进度栏默认隐藏且快捷键切换
悬浮卡片 SHALL 默认不展示，`Ctrl+Shift+P` SHALL 在展示与隐藏之间切换，选择 SHALL 跨刷新保留。

#### Scenario: 默认不展示
- **WHEN** 会话存在当前交付任务且用户未按过快捷键
- **THEN** 卡片 SHALL NOT 渲染任何可见内容

#### Scenario: 快捷键切换并保留
- **WHEN** 用户按下 `Ctrl+Shift+P`
- **THEN** 卡片 SHALL 切换展示状态，且该选择 SHALL 写入客户端本地存储并在刷新后保留

### Requirement: 任务列表回落到 todo 投影
悬浮卡片的「任务列表」组在交付清单为空且存在 todo 项时 SHALL 展示 todo 项与状态，并标注来源。

#### Scenario: 清单为空时展示 todo 项
- **WHEN** `delivery-tasks` 清单为空且 `todos` 投影非空
- **THEN** 卡片 SHALL 渲染 todo 项的 content 与三态 status，并标注该来源

#### Scenario: 清单非空时不混排
- **WHEN** `delivery-tasks` 清单非空
- **THEN** 卡片 SHALL 只渲染交付清单，SHALL NOT 渲染 todo 项
