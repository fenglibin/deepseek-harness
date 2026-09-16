## MODIFIED Requirements

### Requirement: 规模分级三层判定

需求规模 SHALL 由程序化规则判定。判定 SHALL 区分「可拆分」与「结构契约级变更」两种语义：列出多条要点表达的是可拆分性，SHALL 单独判定为 `l1`；只有结构契约级变更 SHALL 判定为 `l2`。

#### Scenario: 编号列表需求判定为 l1

- **WHEN** 请求文本包含 3 条及以上编号项，但未命中任何强信号且中等信号不足 2 个
- **THEN** 系统 SHALL 判定为 `l1`，并 SHALL 创建 `l1` 交付任务

#### Scenario: 编号列表叠加中等信号升 l2

- **WHEN** 请求包含 3 条及以上编号项，且另命中 1 个中等信号
- **THEN** 系统 SHALL 判定为 `l2`

#### Scenario: 长需求直接升 l2

- **WHEN** 直接人类请求文本长度超过 `openspecThreshold.descriptionChars`
- **THEN** 系统 SHALL 在 `agent/pre-step` 直接创建 `l2` 任务，无需模型调用工具

#### Scenario: 无信号需求自由执行

- **WHEN** 文本未超阈值且未命中任何信号
- **THEN** 系统 SHALL 不自动创建任务，并 SHALL 注入 rubric 消息交由模型判定；模型未声明时按 `l0` 自由执行

### Requirement: l1 任务的确定性产生

判定为 `l1` 的请求 SHALL 自动创建交付任务，不得仅依赖模型自愿调用创建工具。

#### Scenario: l1 自动创建任务

- **WHEN** `agent/pre-step` 的扫描判定当前人类请求为 `l1`
- **THEN** 系统 SHALL 创建 `l1` 交付任务，其阶段序列 SHALL 包含 `designed`

#### Scenario: l0 不创建任务

- **WHEN** 扫描判定为 `l0`
- **THEN** 系统 SHALL 不创建交付任务，并 SHALL 注入 rubric 交由模型判定

### Requirement: 单一任务源

`delivery-tasks` SHALL 是任务清单的唯一权威源。非 `l2` 任务经 `todo_write` 提交的清单 SHALL 同步为持久的 `delivery/tasks` 写入，使进度不因轮次更替而丢失。

#### Scenario: l1 的 todo 写入同步为持久清单

- **WHEN** 当前任务级别为 `l1` 且模型调用 `todo_write`
- **THEN** 系统 SHALL 追加一条 `delivery/tasks` 持久事件，其 `changeId` 为空串且清单项与本次 `todo_write` 一致

#### Scenario: 进度面板只读持久清单

- **WHEN** 会话存在当前交付任务且已记录清单
- **THEN** 进度面板 SHALL 只依据 `delivery-tasks` 渲染任务列表，SHALL NOT 回退到当轮 `todos`

### Requirement: 配置集中管理

分级阈值、信号词表与验证开关 SHALL 集中注册为设置服务的 `delivery` namespace，并 SHALL 可在设置界面中编辑。

#### Scenario: 阈值可在设置中覆盖

- **WHEN** 用户或部署覆写 `delivery` namespace 的阈值与信号清单
- **THEN** 判定逻辑 SHALL 使用覆盖后的值；设置服务未挂载时 SHALL 回退到组合配置与 schema 默认值

#### Scenario: 布尔与枚举项可在设置界面编辑

- **WHEN** 用户在设置界面编辑 `enforcement`、`autoDetect` 或 `requireOpenspecForBugs`
- **THEN** 界面 SHALL 以布尔或枚举控件呈现并可写入对应类型的值，SHALL NOT 以字符串控件承载

#### Scenario: enforcement 关闭在运行期生效

- **WHEN** 用户在设置中将 `enforcement` 改为 `off`
- **THEN** 门禁执行点 SHALL 按当前策略短路，不再阻断后续推进

### Requirement: 进度语义化呈现

进度面板 SHALL 按阶段分组呈现任务清单的完成度，并 SHALL 标明清单的权威来源。

#### Scenario: 按阶段分组展示完成度

- **WHEN** 会话存在当前交付任务且已记录清单
- **THEN** 面板 SHALL 按生命周期阶段分组显示该阶段的已完成数与总数，数据 SHALL 取自 `delivery-tasks` 投影的 `progress`

#### Scenario: 进度面板具有常驻入口

- **WHEN** 会话存在当前交付任务
- **THEN** 面板 SHALL 可从常驻入口访问，SHALL NOT 仅依赖快捷键唤出

#### Scenario: 分级依据可跟踪

- **WHEN** 任务被创建并分级
- **THEN** 系统 SHALL 记录并可展示该分级的命中依据，使分级结果可追溯

## ADDED Requirements

### Requirement: 实现验证的三类输入与四道检查

`verified` 阶段 SHALL 依据原始需求、任务列表与设计文档三类输入执行验证。验证 SHALL 包含清单完整性、覆盖性、产物核验与逐条对账四道检查。

#### Scenario: 清单未完成阻止验证

- **WHEN** 权威任务列表仍存在状态非 `completed` 的项，或 l0/l1 任务未记录任何清单
- **THEN** 系统 SHALL 阻止推进到 `verified`，并 SHALL 指明未完成项

#### Scenario: 需求与设计点未覆盖被列出

- **WHEN** 存在未被任何已完成项通过 `covers:` 声明的原始需求要点或 `### D<n>` 设计决策
- **THEN** 系统 SHALL 列出未覆盖项并回注模型

#### Scenario: 命令核验失败阻止验证

- **WHEN** `openspec validate --strict --json` 退出码非 0，或配置的 `postHooks` 命令未全绿
- **THEN** 系统 SHALL 阻止推进到 `verified`，且 SHALL NOT 因模型确认完成而豁免

#### Scenario: 逐条对账取代自由文本

- **WHEN** 模型推进任务到 `verified`
- **THEN** 系统 SHALL 要求以「原始需求第 N 条 → 实现位置与证据」的结构化形式对账，SHALL NOT 接受一段自由文本作为放行依据

### Requirement: 复核轮次按任务隔离

验证复核轮次 SHALL 随任务记录，不得使用跨会话共享的进程级计数器。

#### Scenario: 轮次上限按任务独立生效

- **WHEN** 同一进程中不同会话的任务各自发生复核
- **THEN** 每个任务的复核轮次 SHALL 独立计数，互不影响
