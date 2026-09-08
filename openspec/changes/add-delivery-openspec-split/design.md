## Context

分级判定当前只吃 objective 长度这一个信号：`agent/pre-step` 向 `inferLevel` 传入空的 `todoCount`/`touchedFiles`，300~1199 字符得 `l1`、≥1200 得 `l2`，低于 300 不建任务。写进工具描述的规模 rubric 只在模型主动调用 `create_delivery_task` 时参与，而自动创建已经抢先建好任务，因此一个跨 host/client、含 5 项子需求的复合需求被判为 `l1`。

openspec 0.16.0 的实测决定了接入方式：`validate --strict --json` 输出结构化 issues 且退出码 0/1，可直接接现有 `postHooks`；`show --json` 能解析 requirements 与 scenarios 但不含 tasks 完成度；`openspec init` 会写入项目根 `AGENTS.md`，而本仓库根 `AGENTS.md` 是真实文件。

## Decision

### D1 规模三层判定

字符地板 >200 直接 `l2`；否则扫描强/中/弱信号（以配置中的字符串数组表达），强信号任一或中等信号 ≥2 得 `l2`，中等 1 或弱 ≥2 得 `l1`，否则 `l0` 自由执行。自动创建负责前两层，第三层由 `agent/pre-step` 注入 rubric 消息交由模型判定。阈值与信号词表不硬编码，注册为设置服务 `delivery` namespace，经 `installSection` 接线，服务缺失时回退到组合配置。

### D2 openspec 四件套

`record_spec` 按 kind 写 proposal/design/tasks/specs 四个文件；change-id 取动词开头的 kebab-case，与 delivery 的 `task-<uuid>` 建映射记入 durable 事件。任务清单与逐项状态另以 durable 事件承载，fold 成独立投影单元，避免改动既有 `delivery` 投影的严格字段白名单。

### D3 双进度呈现

悬浮卡片在阶段条每个节点下显示该阶段子任务完成度，当前阶段自动展开、已完成阶段折叠为摘要。数据源是 D2 的投影，不读磁盘。

### D4 单一任务源与 validate 接入

`tools/pre-execute` 钩子在 `l2` 下拦截 `todo_write`；`postHooks` 接入 `openspec validate <change-id> --strict --json`，`--json` 的 issues 回注模型；推进 `implemented` 时用磁盘 `tasks.md` 的实际勾选与上报状态交叉核对。

### D5 逐点验证与坡度

验证点清单由 `openspec show --json` 的 requirements/scenarios 与 `design.md` 决策点合并而成，作为验收基准；`tasks.md` 每项以 `covers:` 标注所覆盖的验证点，取值按枚举校验。四层校验为覆盖完整性（正向与反向）、实现完成度、行为正确性。程序初检发现差异时不阻断，回注模型逐点复核，复核通过即放行并留痕；但 `validate` 非 0 或验证命令未全绿时不接受复核豁免。复核轮次上限默认 2 轮。

### D6 文档与快照

更新包 README、重生成工具与配置目录、补 Agent Note、录制会话快照，并在交付前执行编译与本次变更单测两项门禁。

## Consequences

- 大需求必然进入 `l2`，随之带来 design 与 openspec 拆分的 token 成本；以 `enforcement` 的 `advisory` 档与可配置阈值作为出口。
- `l2` 下 `todo_write` 不可用，模型必须维护 `tasks.md`，短期增加调用次数。
- 新增 durable 事件与投影单元必须保持向后兼容：新事件带 ignorable 语义，独立投影不动既有 fold。
- `openspec init` 被禁用，change 目录由 `ctx.fs` 直接创建，根 `AGENTS.md` 不受影响。
