## ADDED Requirements

### Requirement: 规模分级三层判定
需求规模 SHALL 由程序化规则判定，长需求与命中强信号的需求 SHALL 进入 `l2`，无信号的小需求 SHALL 自由执行而不创建交付任务。

#### Scenario: 长需求直接升 l2
- **WHEN** 直接人类请求文本长度超过 `openspecThreshold.descriptionChars`（默认 200）
- **THEN** 系统 SHALL 在 `agent/pre-step` 直接创建 `l2` 任务，无需模型调用工具

#### Scenario: 短需求命中强信号升 l2
- **WHEN** 请求文本长度未超过阈值，但命中任一强信号
- **THEN** 系统 SHALL 判定为 `l2`；命中中等信号 1 个或弱信号 2 个时 SHALL 判定为 `l1`

#### Scenario: 无信号需求自由执行
- **WHEN** 文本未超阈值且未命中任何信号
- **THEN** 系统 SHALL 不自动创建任务，并 SHALL 注入 rubric 消息交由模型判定；模型未声明时按 `l0` 自由执行

### Requirement: openspec 四件套与 validate 门禁
`l2` 任务 SHALL 产出合规的 openspec change 四件套，且验收 SHALL 以 `openspec validate --strict` 的退出码为准。

#### Scenario: l2 任务产出合规 change 目录
- **WHEN** 任务推进到 `specified`
- **THEN** `record_spec` SHALL 写出 proposal.md、design.md、tasks.md 与 specs/<capability>/spec.md，change-id 为动词开头的 kebab-case

#### Scenario: validate 失败阻止验收
- **WHEN** `openspec validate --strict` 退出码非 0
- **THEN** 系统 SHALL 阻止推进到 `accepted`，并 SHALL 把 `--json` 的 issues 回注模型

### Requirement: 双进度呈现
左侧悬浮卡片 SHALL 同时呈现生命周期阶段与每个阶段的子任务进度。

#### Scenario: 阶段下展示子任务进度并自动展开
- **WHEN** 会话存在当前交付任务
- **THEN** 卡片 SHALL 在每个阶段节点下显示该阶段子任务的已完成数与总数，当前阶段 SHALL 自动展开

### Requirement: 单一任务源
`l2` 任务 SHALL 以 openspec `tasks.md` 为唯一任务源。

#### Scenario: l2 下 todo_write 被拦截
- **WHEN** 当前任务级别为 `l2` 且模型调用 `todo_write`
- **THEN** 系统 SHALL 返回 blocking 决策并提示改用 `record_spec(kind: 'tasks')`

### Requirement: 逐点验证闭环
`l2` 验收 SHALL 以程序化提取的验证点清单为基准，逐点确认 task 与方案文档的每个点都有实现。

#### Scenario: 未覆盖的验证点被列出并回注
- **WHEN** 存在未被任何 task 的 `covers:` 引用的 Scenario 或设计点
- **THEN** 系统 SHALL 列出未覆盖点并回注模型，复核通过即放行并留痕；确认空泛或超轮次 SHALL 硬阻断

#### Scenario: 命令失败类不因复核放行
- **WHEN** `openspec validate --strict` 退出码非 0 或 `postHooks` 验证命令未全绿
- **THEN** 系统 SHALL 拒绝放行，不因模型确认完成而豁免

### Requirement: 配置集中管理
阈值与信号清单 SHALL 集中注册为设置服务的 `delivery` namespace。

#### Scenario: 阈值可在设置中覆盖
- **WHEN** 用户或部署覆写 `delivery` namespace 的阈值与信号清单
- **THEN** 判定逻辑 SHALL 使用覆盖后的值；设置服务未挂载时 SHALL 回退到组合配置与 schema 默认值
