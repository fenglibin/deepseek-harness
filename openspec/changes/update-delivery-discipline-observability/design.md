## Context

分级判定由两处串联而成：`grading.ts` 的纯文本扫描负责强/中/弱信号与长度地板，`index.ts` 的 `inferLevel` 在其上叠加模型自报的 `todoCount`/`touchedFiles`/`is_bug`。两条触发路径不对称：`agent/pre-step` 的 autoDetect 只在扫描结果为 `l2` 时自动建任务，`l0`/`l1` 一律注入 rubric 交由模型决定。

三档的差异仅在阶段序列与少量门禁，工具集完全相同。阶段序列表在 `packages/delivery/delivery/src/fold.ts` 与 `packages/client/ui-delivery/src/client/delivery-phases.ts` 各定义一份。

任务列表的三个源中，`todos` 由 `tool-todo` 的投影在 `turn/start` 清空，`delivery-tasks` 由 `record_tasks` 写入且已携带按阶段聚合的 `progress`，`openspec/.../tasks.md` 是 l2 的磁盘权威。

`verified` 阶段现有的 `coverageGap()` 依赖 `openspec show <changeId> --json`，并对空 `changeId` 直接返回。

## Decision

### D1 编号列表信号降级为 medium

`scanSignals` 将「≥3 条编号项」计为一个 strong 命中，使任何列出 3 条要点的需求无条件进入 `l2`。该规则表达的是**可拆分**，而 `l2` 的语义是**结构契约级变更**（须产出 OpenSpec 四件套），两者不应等价。将编号列表改为计入 medium：单独命中判定为 `l1`（出设计文档），与其它 medium 信号叠加达 2 个时才升 `l2`。

长度阈值 `specChars` 在本次改造中保持默认 `200` 不变。理由是实测显示本次误判由编号规则主导而非阈值，同时修改两个变量会使归因失效；阈值留待编号规则修正后用真实文本回归再定。

强信号词表中「重构 / 迁移 / 优化 / 替换 / 升级」等在日常措辞中高频出现的模式予以收窄，避免非结构性改动被归入 `l2`。

### D2 l1 纳入自动创建

autoDetect 判定为 `l1` 时同样创建任务，使交付纪律覆盖所有非小微需求；`l0` 保持自由执行不建任务。该改动消除 l1 档缺少确定性产生路径的问题，代价是左侧进度卡片在更多会话中出现。

### D3 单一任务源

l1 任务存续期间，`tool-delivery` 监听 `session/event` 捕获 `todo/write`，将其映射为一条持久的 `delivery/tasks` 写入（`changeId` 为空串），使 `delivery-tasks` 成为唯一权威源。`DeliveryFloatCard` 相应移除 `items.length === 0 ? todos ?? [] : []` 的双源择一逻辑，只读 `delivery-tasks`。

被放弃的方案：l1 也禁用 `todo_write` 强制 `record_tasks`（源唯一但模型须多调一个更重的工具）；保持双源仅改 UI 分别展示（漂移问题依旧，只是变得可见）。

### D4 实现验证的三类输入与四道检查

`verified` 阶段的检查改为固定四道：

1. **清单完整性**：权威源（l2 为磁盘 `tasks.md`，l0/l1 为 `delivery-tasks`）的全部项均为 `completed`。l0/l1 未记录清单时不再静默放行。
2. **覆盖性**：每条原始需求要点与每个 `### D<n>` 设计决策均被至少一条已完成项通过 `covers:` 声明覆盖，l1 一并纳入。
3. **产物核验**：`openspec validate <change_id> --strict --json`（l2）由 `accepted` 前移至 `verified`。配置的验收命令是提示词命令而非 shell 命令——它们的正文由模型执行，没有退出码可判——因此改为在 `accepted` 校验该任务是否留下了每条命令的执行记录；`accepted` 不再重复执行 shell 核验。
4. **逐条对账**：模型须结构化输出「原始需求第 N 条 → 实现位置与证据」，取代现有的一段 ≥20 字自由文本。

第 1、3 道为确定性判定，不可由模型叙述豁免；第 2、4 道允许在轮次上限内复核。

### D5 复核轮次随任务持久化

`reviewRounds` 由模块级 `Map` 改为随任务状态记录，使轮次上限按任务与阶段独立生效，不再跨会话共享。

### D6 设置卡片字段控件扩展

`card-form.ts` 现有 `numberField` 与 `textField`，其 `FieldWrite` 已提供 `set`/`clear` 抽象。据此新增布尔控件与枚举控件，并为词表数组提供列表控件或按行解析的多行文本控件。数值阈值沿用 `numberField`。

被放弃的方案：把布尔与枚举编码进 `textField` 的字符串。该做法无法表达 `false` 与未设置的区别，且会让 schema 校验与设置界面产生分歧。

### D7 分层边界

不拆为三个独立包。分级、分组执行与实现验证共享同一份 `ResolvedConfig`、同一套工具注册流程与同一个门禁执行点，拆包只获得形式边界而引入跨包契约。改为在 `tool-delivery` 内按模块分层，另新增一个客户端设置卡片包注册 `settings.plugin.item` 中 `key: 'delivery'` 的卡片。

### D8 进度呈现与阶段表单源

`DeliveryFloatCard` 的任务组改读 `delivery-tasks.progress`，按阶段分组显示 `done/total` 并标明当前权威源。进度面板提供常驻入口，不再仅依赖快捷键唤出。分级判定结果记录并展示命中依据，使分级可跟踪。`LEVEL_PHASES` 合并为单一来源，消除 host 与 client 两份定义的分歧。

### D9 enforcement 的运行期一致性

`apply()` 开头的 `enforcement === 'off'` 是加载期判定，而设置服务的 `onChange` 只更新内存策略，导致用户在设置中选 `off` 后工具已注册却不注销。修正为运行期可生效：门禁执行点按当前策略短路，并明确 `off` 与 `enabled: false` 的差异。

## Consequences

- 编号规则降级使问题式需求回到 `l1`，OpenSpec 四件套产生频率下降，交付留痕变轻；若后续发现 `l2` 过少，应通过收窄 medium 信号而非恢复编号规则来调整。
- l1 自动创建使会话日志与左侧卡片的出现频率上升。
- `verified` 加强后，此前空转通过的任务将首次产生阻断，需同步更新受影响的测试期望与快照。
- 新增的 `delivery/tasks` 写入沿用既有事件类型与严格解码器，不提升 `SESSION_FORMAT_VERSION`；但 l1 从此也写入该事件，重放路径需覆盖空 `changeId` 的情形。
- `LEVEL_PHASES` 单源化会同时触及 host 与 client 两个编译面，需保持两面的类型引用一致。
