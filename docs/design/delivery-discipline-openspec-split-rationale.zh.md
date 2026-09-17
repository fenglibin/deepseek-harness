# 交付纪律 openspec 拆分与双进度方案

> 状态：决策已对齐，待实施
> 分级机制已变更：[交付纪律以模型判定替换关键词分级](delivery-llm-grading.zh.md)移除了本文描述的关键词表与程序化扫描，改以长度闸门加一次模型调用定级。本文其余部分作为当时的方案记录保留。

> 目标读者：维护者与决策者
> 关联诉求：让大需求按「方案文档 → openspec 拆分 → 按任务编码验证 → 进度可见 → 变更留痕」闭环执行，并满足确定性、可观测性、可追溯性、可验证性。
> 关联文档：[交付纪律方案](delivery-discipline-rationale.zh.md)、[自动触发方案](delivery-discipline-auto-trigger-rationale.zh.md)

---

## 1. 背景与动机

一次真实大需求会话暴露了交付纪律子系统在 openspec 拆分环节的断层。该需求（「设置」中 MCP 页面配置服务细节优化，含 5 项子需求、跨 host/client、涉及 5 个以上 package）的 objective 长度为 367 字符，被机械地板判定为 `l1`，因此 `specified` 阶段从未进入，全会话无 `record_spec` 调用，`specCount` 为 0。

工作分解交由 `todo_write` 完成（10 项 `pending`/`in_progress`/`completed` 条目），这带来三个问题。**不可验证**：`todo_write` 的状态由模型自报，`- [x]` 勾完与否没有机器证据，模型可以把未做的工作标成已完成。**不可追溯**：`todo/write` 只存在于 session log，不落盘到 git，且下一轮次清空，事后无法回答「当时拆了哪几项、各自完成到什么程度」。**不可观测**：左侧悬浮卡片只渲染 `created → … → accepted` 六个生命周期阶段，与 `todo_write` 拆出的 10 项子任务完全不通气，用户看到的进度条是「阶段跑马灯」而非真实工作量。

更根本的断层在第二层：即便任务被判为 `l2`，`record_spec` 目前只是把自由文本追加到 `openspec/changes/<task-id>/spec.md`。该文件既不是 openspec 的 change 布局（缺 `proposal.md`、`tasks.md`、`design.md`、`specs/<capability>/spec.md`），也不含 openspec 要求的 `## ADDED Requirements` / `#### Scenario:` / `SHALL` 结构，更没有接入 `openspec validate`。因此「通过 openspec 拆分任务」这条链路在当前实现里从未真正闭合。

本方案补齐这条链路，并把任务拆分、执行、验证、呈现统一到 openspec 的 change 布局上。

---

## 2. 目标

- **确定性**：需求规模分级由程序化规则（字符数地板 + 强信号扫描）判定，不依赖模型记得调用；阶段推进由 compare-and-set 状态机强制；验收由 `openspec validate --strict` 的退出码把关。
- **可观测性**：左侧悬浮卡片呈现「阶段 + 子任务」双进度，每个阶段展开显示该阶段子任务完成情况，阶段推进时自动切换并展开。
- **可追溯性**：openspec change 四件套落盘到 git；任务清单与状态同步为 durable session 事件；判定依据、validate 结果、后置命令输出均可在 session log 中重建。
- **可验证性**：`l2` 验收以程序化提取的验证点清单为基准（spec 的每个 Scenario 与方案文档的每个设计点），经 `covers:` 标注与 task 建立双向索引，执行覆盖完整性、实现完成度、行为正确性四层校验（§6.5），逐点确认而非只看勾选。
- **结果正确性**：`l2` 任务以 openspec `tasks.md` 为唯一任务源，`todo_write` 在 `l2` 下被拦截；验收把方案文档、task 清单与 `openspec validate --strict` 及后置验证命令的证据绑在一起，确保每个点都有正确实现，而非模型声称完成。

---

## 3. 非目标

- 不改变 `agent-loop` 本身（遵循「Plugins, not loop changes」）；所有能力落在 delivery 包族与既有扩展点上。
- 不重新实现 spec 格式或任务拆分格式——复用 openspec 原生布局与 CLI。
- 不替代人工评审：本方案校验「已记录产物是否被覆盖」，不判断实现在业务语义上是否正确。
- 不约束子代理与 workflow 子任务；根 agent 的任务仍是唯一作用域。
- 不迁移已有的 4 个 `task-<uuid>/spec.md` 历史产物（见 §8 风险）。

---

## 4. 现状分析

### 4.1 分级判定

[`tool-delivery`](../../packages/delivery/tool-delivery/src/index.ts) 的 `inferLevel` 由两个阈值驱动：`designThreshold`（`todoCount` 5、`descriptionChars` 300、`touchedFiles` 3）决定 `l1`，`openspecThreshold`（`todoCount` 15、`descriptionChars` 1200）决定 `l2`。自动创建发生在 `agent/pre-step` 监听器里，它只在 objective 长度达到 `designThreshold.descriptionChars`（300）时触发，并向 `inferLevel` 传入 `{ todoCount: 0, touchedFiles: 0, isBug: false }`。

结果是自动路径上**只有 objective 长度这一个信号生效**：300~1199 字符得 `l1`，≥1200 字符得 `l2`，低于 300 不建任务。写进 `create_delivery_task` 描述里的规模 rubric（强信号 S1/S4 判 `l2`、S2/S3 判 `l1`）只在模型主动调用该工具时参与判定，而自动创建已经抢先建好了任务，模型不会再去升降级。

因此一个 367 字符、跨 host/client、含 5 项子需求的复合需求被判为 `l1`，与它的实际规模不符。

### 4.2 openspec 集成

`record_spec` 把一条自由文本追加到 `openspec/changes/<task-id>/spec.md`。现存 4 个 change 目录都是这一形态，与 openspec 的 change 布局存在三处偏离，任何一处都会让 `openspec validate --strict` 失败：

| 维度 | 当前产物 | openspec 要求 |
|---|---|---|
| 目录名 | `task-<uuid>` | kebab-case、动词开头（`add-`/`update-`/`remove-`/`refactor-`） |
| 文件布局 | 单个 `spec.md` 放在 change 根 | `proposal.md` + `tasks.md` + `design.md` + `specs/<capability>/spec.md` |
| spec 结构 | 自由 markdown 分节 | `## ADDED\|MODIFIED\|REMOVED\|RENAMED Requirements`，每个 Requirement 至少一个 `#### Scenario:`，正文含 `SHALL`/`MUST` |

### 4.3 openspec CLI 实测结论

对 openspec 0.16.0（`openspec` 全局可用，不在 workspace `node_modules` 内）的实测结果决定了本方案的接入方式：

| 能力 | 实测行为 | 对方案的影响 |
|---|---|---|
| `validate <id> --strict --json` | 输出 `{ items: [{ id, type, valid, issues: [{level,path,message}] }], summary: { totals: { items, passed, failed } } }` | 可直接解析为门禁结果，`issues` 提供可展示的失败原因 |
| `validate` 退出码 | 合法为 0，非法为 1（是否带 `--strict` 一致） | `postHooks` 现有的 `exitCode === 0` 判定即可复用，无需改框架 |
| `show <id> --json` | 返回 `id`/`title`/`deltaCount`/`deltas[].requirements[].scenarios`，**不含 tasks 完成度**；scenario 条目只有 `rawText`、**无标题** | 子任务进度不能从 `show` 取，须解析 `tasks.md`；验证点键不能从 `show` 取，须解析 spec 的 `#### Scenario:` 标题 |
| `openspec list` | 文本输出含 `2/5 tasks`，但不支持 `--json` | 仅适合人类阅读，不做程序化数据源 |
| `init --tools none <path>` | 建 `openspec/project.md` 与 `openspec/AGENTS.md`，**并写入项目根 `AGENTS.md`** 的 `<!-- OPENSPEC:START -->` 块 | 本仓库根 `AGENTS.md` 是真实文件（`CLAUDE.md` 符号链接指向它），`init` 会破坏它，必须规避 |
| `init` 与 `config.yaml` | 0.16.0 的 `init` 不生成 `config.yaml` | 不依赖 `config.yaml` 存在与否 |

### 4.4 进度呈现

[`DeliveryFloatCard`](../../packages/client/ui-delivery/src/client/DeliveryFloatCard.tsx) 读 `delivery` 投影，折叠时显示分级徽标、阶段与截断的 objective，展开后显示阶段进度条、`nextGate` 门禁提示与产物路径。它的数据全部来自 `DeliverySnapshot` 的 `changeCount`/`designCount`/`specCount` 三个计数，没有任何子任务维度的信息；`delivery` 投影的 fold 严格限定字段集合，也不承载任务清单。

---

## 5. 方案对比与选型

### 5.1 规模分级：谁来判

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 纯字符地板 | 只按 objective 长度分档 | 已证伪：367 字符的复合需求被判 `l1` |
| B. 纯 LLM rubric | 只靠提示词让模型判断 | 已证伪：模型会忽略或忘记调用 |
| C. 字符地板 + 强信号扫描 + rubric 兜底（选定） | 长文本与强信号由程序硬判，短文本交由模型按 rubric 判 | 长需求 100% 确定；短需求有机械地板保底；rubric 只补程序识别不了的语义信号 |

### 5.2 子任务源：todo_write 还是 openspec tasks.md

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 继续用 `todo_write` | 现状 | 无机器可验证性，状态由模型自报，不落盘 |
| B. openspec `tasks.md` 为唯一源（选定） | `l2` 下 `todo_write` 被拦截，任务写在 `tasks.md` checkbox | 机器可验证、可落盘追溯，但要求模型按 checkbox 维护 |
| C. 两者并存 | 各自维护 | 双源不一致时无从判断，制造实现遗漏 |

### 5.3 子任务进度如何到达 UI

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 客户端直读 `tasks.md` | 前端解析磁盘文件 | 违反「session log 是唯一持久权威」，且客户端无 fs 能力 |
| B. host 解析 `tasks.md` 并投影 | 服务端读文件、数 checkbox，作为投影推送 | 数据真实（读的是磁盘真相），但不进 session log |
| C. durable 事件承载任务清单，验收时用磁盘 checkbox 交叉核对（选定） | 模型经工具上报清单与状态，写 durable 事件；推进阶段时程序读 `tasks.md` 核对 | 可追溯（事件在 log 里）+ 可验证（磁盘是真相，防虚报） |

---

## 6. 推荐方案详解

### 6.1 规模分级（决策 1）

判定分三层，按短路顺序执行，任一层命中即停：

**第一层 · 字符地板（程序，硬）**：拼接后的直接人类请求文本长度 > `openspecThreshold.descriptionChars`（200）→ 直接 `l2`。该层在 `agent/pre-step` 监听器里创建任务，不需要模型配合。

**第二层 · 强信号扫描（程序，硬）**：长度 ≤ 200 时，对请求文本做强信号模式扫描，命中任一即 `l2`；中等信号命中 ≥2 个或弱信号命中 ≥2 个时按 §6.1.1 的表降级到 `l1`。

**第三层 · 模型 rubric（软）**：前两层都不命中时，`agent/pre-step` 注入一条 plugin 来源的 user message，要求模型在当轮用 `create_delivery_task` 显式声明分级。该注入进 session log，因此判定过程可追溯。模型未声明即视为 `l0` 自由执行。

按「宁可将小需求升级，也不将大需求误判为小需求」的原则，分档如下：

| 命中 | 分级 |
|---|---|
| 字符地板（>200） | `l2` |
| 强信号任一 | `l2` |
| 中等信号 ≥2 | `l2` |
| 中等信号 1，或弱信号 ≥2 | `l1` |
| 无命中 | `l0`（自由执行，不建任务） |

#### 6.1.1 信号清单

| 层级 | 信号 |
|---|---|
| 强信号 | S1 新增/修改结构契约：capability seam、session event、持久化 schema 或 projection、公共 API/协议、跨版本数据格式 |
| 强信号 | S2 非小微 bug 修复：涉及数据格式、协议、兼容性或安全 |
| 强信号 | S3 安全相关：鉴权、权限、沙箱、密钥处理、注入面 |
| 强信号 | S4 跨进程/跨边界协议变更：RPC、IPC、wire format、SDK 对外契约 |
| 强信号 | S5 持久化格式或版本迁移：`SESSION_FORMAT_VERSION`、数据库 schema、磁盘格式 |
| 强信号 | S6 结构性动词（重构/迁移/重写/升级/替换）且涉及 ≥2 个模块 |
| 强信号 | S7 需求含 ≥3 个可独立验收的子需求 |
| 强信号 | S8 删除或废弃公共 API、既有行为变更 |
| 中等信号 | M1 跨 host 与 client 两端 |
| 中等信号 | M2 触及 ≥3 个 package |
| 中等信号 | M3 修改被广泛引用的公共符号 |
| 中等信号 | M4 新增完整功能或能力 |
| 中等信号 | M5 涉及 ≥2 个需权衡的设计决策 |
| 弱信号 | W1 可拆成 ≥3 个独立可验证子任务 |
| 弱信号 | W2 存在性能或资源预算考量 |
| 弱信号 | W3 涉及用户可见的 UI 呈现变更 |

强信号与中等信号以可机检的模式表达（关键词与路径模式），弱信号交由模型在 rubric 层判断。字符阈值 `openspecThreshold.descriptionChars` 由 1200 下调为 200，`designThreshold.descriptionChars` 由 300 下调为 60，使短需求也进入信号扫描而非直接放行。

### 6.2 openspec change 四件套与 validate 门禁（决策 2）

`l2` 任务的 `specified` 阶段产出一份完整的 openspec change。change 目录名取动词开头的 kebab-case id（如 `add-mcp-settings-optimization`），与 delivery 的 `task-<uuid>` id 建立映射并记入 durable 事件，使两侧可互查。

`record_spec` 重构为按 kind 写四件套，一次调用落一个文件：

| 调用 | 落盘路径 | 内容要求 |
|---|---|---|
| `record_spec(kind: 'proposal')` | `openspec/changes/<change-id>/proposal.md` | 变更意图：Why 与 What Changes |
| `record_spec(kind: 'design')` | `openspec/changes/<change-id>/design.md` | 技术决策：Context、Decision、Consequences |
| `record_spec(kind: 'tasks')` | `openspec/changes/<change-id>/tasks.md` | 分组的 checkbox 清单，`- [ ] <序号> <描述>` |
| `record_spec(kind: 'spec')` | `openspec/changes/<change-id>/specs/<capability>/spec.md` | `## ADDED\|MODIFIED\|REMOVED Requirements`，每个 Requirement 至少一个 `#### Scenario:`，正文含 `SHALL`/`MUST` |

`tasks.md` 的清单同时以 durable 事件承载（§6.3），进度呈现读事件，验收核对读磁盘。

**validate 接入**：`postHooks` 基线加入 `openspec validate <change-id> --strict --json`。该命令非法时退出码为 1，`runPostHooks` 现有的 `exitCode === 0` 判定直接生效；`--json` 输出解析后把 `issues[].message` 回注给模型，使失败原因可见而非只有一个退出码。到达 `accepted` 前按任务的 change id 定向跑 `openspec validate --strict --json`，既校验拆分本身合规、也校验实现过程中 spec 未被破坏；change id 由清单在 `implemented` 之前写入 durable，故此时可用。

**规避 `init` 破坏根 `AGENTS.md`**：不调用 `openspec init`。change 目录由 `record_spec` 经 `ctx.fs` 直接创建；`openspec/project.md` 与 `openspec/AGENTS.md` 作为仓库内的既有资产手工补齐一次，不由 CLI 生成。

### 6.3 双进度呈现（决策 3）

左侧悬浮卡片改为「阶段 + 子任务」双进度：

- 阶段条保持 `created → designed → specified → implemented → verified → accepted`，按分级裁剪（§4.4 的 `LEVEL_PHASES` 逻辑不变）。
- 每个阶段节点下方显示该阶段的子任务进度 `已完成/总数`，数据来自该阶段关联的任务清单。
- 当前阶段自动展开：阶段推进时卡片切到新阶段并展开其子任务；已完成的阶段折叠为一行摘要，保留勾选项数。
- 阶段与子任务的归属由任务清单携带的阶段标记决定，模型在 `record_spec(kind: 'tasks')` 时声明每项属于哪个阶段。

**数据源**：新增 durable 事件承载任务清单与逐项状态，由 delivery 包族 fold 成一个独立的投影单元（不改动现有 `delivery` 投影的字段集合，避免破坏 `decodeSnapshot` 的严格字段白名单）。悬浮卡片读该投影，因此进度随模型工作实时更新，且全过程可从 session log 重建。

**交叉核对**：推进到 `implemented` 时，程序读取磁盘 `tasks.md` 数出 `- [x]` 与 `- [ ]`，与投影中的上报状态比对。不一致即以 blocking 错误拒绝推进并列出差异项，防止模型虚报完成。

### 6.4 单一任务源（决策 4）

`l2` 任务下 `todo_write` 被拦截：在 `tools/pre-execute` 注册钩子，当当前 delivery 任务级别为 `l2` 且被调用的工具是 `todo_write` 时返回 blocking 决策，提示改用 `record_spec(kind: 'tasks')` 维护 `tasks.md`。`l0`/`l1` 任务不受影响，`todo_write` 仍用于轻量跟踪。

### 6.5 L2 逐点验证闭环

`tasks.md` 的 checkbox 由模型勾选，`openspec validate --strict` 只校验 spec 的格式结构；两者都通过时仍无法排除「任务全勾但代码未实现」或「实现偏离方案文档」的情形。因此 `l2` 的验证把「方案文档的设计点、spec 的验证场景、`tasks.md` 的实现项」三者绑定后逐点验收，而不以满足 checkbox 计数为止。

**验证点清单（程序化提取，非模型自述）**：capability 列表经 `openspec show <change-id> --json` 的 `deltas[].spec` 得到；Scenario 级验证点由解析 `specs/<capability>/spec.md` 的 `#### Scenario:` 标题得到，键为 `<capability>/<Scenario 名>`。§4.3 实测该命令的 scenario 条目只带 `rawText` 而没有标题，因此不能用作引用键，标题必须从 spec 原文解析。设计侧取 `design.md` Decision 章节下的每个 `### D<n>` 决策标题，键为 `design/D<n>`，与 `.dsh/design/<task-id>.md` 的记录互为索引。二者合并为该任务的验证点清单，作为验收基准。

**task 的覆盖标注**：`tasks.md` 的每个 checkbox 携带 `covers:` 标记，声明其实现的验证点。`covers:` 的取值限定为已从 spec 与 `design.md` 提取出的验证点集合，`record_spec(kind: 'tasks')` 写入时按枚举校验、非法取值直接报错，因此标注是受限选择而非自由文本，模型无法编造验证点：

```text
- [x] 1.3 实现 updateMcpServer (covers: mcp-settings/编辑单个服务器后同步生效, design/D2)
```

**四层校验**（在 `verified` 阶段按序执行，任一不过即 blocking 并列出具体缺失项）：

| 层 | 校验内容 | 拦截的问题 |
|---|---|---|
| 覆盖完整性（正向） | 每个 Scenario 与设计点至少被一个 task 的 `covers:` 引用 | 方案写了却没拆 task，验证点落空 |
| 覆盖完整性（反向） | 每个 task 至少引用一个清单中存在的验证点 | 凭空造任务、任务与方案脱节 |
| 实现完成度 | 所有 task 为 `- [x]`，且磁盘实际勾选与上报状态一致（§6.3） | 虚报完成 |
| 行为正确性 | `openspec validate --strict` 通过，且 `postHooks` 验证命令全绿 | 做了但做错 |

四层全过才允许推进到 `accepted`。失败时把未覆盖的验证点、差异任务与命令输出一并返回模型，使其能定位修复而不是只看到「验证失败」。该机制把 `l2` 的验收从「模型声称完成」变为「清单逐点对照 + 命令证据」。

### 6.6 校验坡度：程序化优先，复核放行

校验的主体是程序化判断，但它发现的问题不直接终结流程。校验结果按坡度分级处理，使流程能够顺序推进，同时保留可审计的痕迹。

| 级 | 触发 | 处理 |
|---|---|---|
| 一级 · 程序初检 | 覆盖完整性、实现完成度、行为正确性的程序化检查发现差异 | 不阻断：把差异清单回注模型——未覆盖的验证点、未勾选的 task、失败命令及其输出——并逐点要求复核 |
| 二级 · 模型复核 | 模型针对每个差异点给出确认或修复 | 覆盖类差异确认通过即放行；命令失败类不接受复核豁免，必须真正通过 |

**复核的适用范围（边界）**：覆盖完整性与实现完成度属于有解释空间的差异——某个验证点已被另一个 task 顺带实现、某两个 task 已合并为一，允许模型复核后放行。行为正确性层以客观命令证据为准：`openspec validate --strict` 退出码非 0，或 `postHooks` 验证命令未全绿时，不接受「已确认完成」的豁免，必须把命令真正跑绿。这条边界让复核用于消除解释歧义，而不是用来绕过机器证据。

**复核的约束**：回注内容必须是具体差异点而非笼统提示；模型须逐点回应，对每个未覆盖的验证点与每个差异 task 各给出一句处置说明，一句话「已完成」不构成有效确认；确认文本与放行决定写入 durable 事件，事后可审计。复核轮次上限可配置（默认 2 轮），超过即硬阻断并提示用户介入，避免复核退化为无限放行。

**可观测**：经复核放行的任务在悬浮卡片与变更记录中标记「复核放行」并链接到对应确认记录，使放行区别于静默通过。

### 6.7 配置集中管理

分级阈值与信号清单是随部署与用户偏好变化的可调项，不硬编码进判定逻辑，统一注册为设置服务的 `delivery` namespace。

**注册方式**：`tool-delivery` 用 schemastery schema 声明策略结构（含 `designThreshold`、`openspecThreshold`、强/中/弱信号清单、`enforcement`、`postHooks`、复核轮次上限），经 `ctx.settings.installSection(...)` 注册，并把组合配置的 `config` 作为 `base` 层。设置服务未挂载时 `installSection` 回退到组合配置，行为与不接设置时完全一致——该回退是 [`dsh-settings`](../../packages/settings/settings/README.zh.md) 的既有能力，因此本批次不引入硬依赖。

**分层与优先级**：schema 默认值 → 组合 `base`（`cordis.yml` 的 `tool-delivery` 条目）→ 用户设置文档分节。用户覆盖优先，变更实时生效，无需重启。

**配置界面**：`describe()` 为每个 namespace 返回 descriptor（序列化 schema、解析值、每层来源、生效时机），配置界面据此渲染表单。后续在「设置」中新增 delivery 分节统一管理阈值与信号清单，每新增一个可调项无需改前端。

**信号清单的形态**：强/中/弱三组信号以字符串数组配置（关键词或路径模式），判定逻辑只消费数组而不内置词表，因此调优信号不必改代码。阈值 200 与 60 是 schema 默认值，部署与用户均可覆盖。

### 6.8 四性对照

| 性质 | 承载机制 |
|---|---|
| 确定性 | 字符地板与强信号由程序判定，阈值与信号词表集中配置（§6.7）；阶段推进 compare-and-set；validate 以退出码把关；`l2` 拦截 `todo_write` |
| 可观测性 | 悬浮卡片双进度与「复核放行」标记；rubric 注入、判定结果与复核确认均进 session log；validate `issues` 与覆盖缺失项回注模型 |
| 可追溯性 | openspec 四件套落盘 git；任务清单与状态为 durable 事件；`covers:` 标注建立验证点与 task 的双向索引；复核确认与放行决定留痕 |
| 可验证性 | 验证点清单程序化提取；覆盖完整性双向校验；实现完成度交叉核对；`validate --strict` 加 `postHooks` 证明行为正确；复核放行须逐点确认且受轮次上限约束 |

---

## 7. 分阶段实施批次

每批独立可验证、可回滚，配置开关控制启用。

| 批次 | 内容 | 验收标志 |
|---|---|---|
| D1 | 分级三层判定 + 策略配置注册：阈值与信号清单注册为 settings namespace、信号扫描表、`agent/pre-step` 分流与 rubric 注入 | 367 字符需求判为 `l2`；纯小微改动不建任务；rubric 注入可回放；未挂载设置服务时回退到组合配置 |
| D2 | `record_spec` 四件套重构 + change-id 映射 + durable 任务清单事件 + 独立投影单元 | `l2` 任务产出合规 change 目录；`openspec validate --strict` 通过 |
| D3 | 悬浮卡片双进度：阶段-子任务归属、自动展开、进度投影 | 卡片随阶段切换展开，子任务进度与 `tasks.md` 一致 |
| D4 | `l2` 拦截 `todo_write` + `postHooks` 接入 `openspec validate --strict --json` + `implemented` 交叉核对 | `l2` 下 `todo_write` 被拒；validate 失败阻止 `accepted`；虚报完成被拒并列出差异 |
| D5 | L2 逐点验证闭环 + 校验坡度：验证点清单提取、`covers:` 解析、四层校验（§6.5）、差异回注与复核放行（§6.6） | 未覆盖的 Scenario 与设计点被列出并回注；复核通过即放行且留痕；空泛确认或超轮次才硬阻断 |
| D6 | 文档与快照：包 README、tool-catalog/config-catalog 重生成、Agent Note、录制会话快照 | `pnpm run doc-sync` 与快照回放通过 |

**交付门禁**：每批进入下一批之前，以及最终交付之前，执行两项检查，未过不继续。

- **编译**：`pnpm run typecheck` 无错误。
- **单元测试**：本次变更触及的 package 其单测全部通过。不要求全仓库单测全绿——仓库可能存在与本次改动无关的遗留失败；判据是与改动前的基线比对，失败项只允许减少、不允许新增。

---

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 200 字符地板把中等需求全升 `l2` | 小需求被迫走 openspec 全流程，token 成本上升 | `enforcement` 保留 `advisory` 档；阈值与信号清单集中在 `delivery` namespace，部署与用户均可覆盖（§6.7） |
| openspec CLI 缺失 | `l2` 的 validate 与拆分不可用 | 缺 CLI 时 fail loud 并降级为 `l1`，不静默跳过 |
| `openspec init` 覆盖根 `AGENTS.md` | 破坏仓库指令文件 | 不调用 `init`，目录由 `ctx.fs` 创建（§6.2） |
| 历史 `task-<uuid>/spec.md` 不合规 | `openspec validate --all` 会失败 | 只按 change-id 校验当前任务，不用 `--all`；历史产物不迁移，保持原状 |
| 新增 durable 事件破坏严格回放 | 旧 session 无法回放 | 新事件带 `ignorable: true` 语义；独立投影单元不动既有 `delivery` fold |
| 模型不维护 `tasks.md` | 交叉核对把任务卡在 `implemented` | 核对失败列出差异项并指示补齐，而非静默拒绝；`enforcement: advisory` 下仅提醒 |
| `covers:` 标注缺失或写错 | 覆盖完整性校验误报，任务卡在 `verified` | 校验失败列出未覆盖点与可疑标注，允许按 Scenario 名模糊匹配降级；`enforcement: advisory` 下仅提醒 |
| 验证点清单提取失败（CLI 缺失或 spec 畸形） | 逐点验证退化为无基准 | 提取失败即 fail loud 并退回 `validate --strict` 加计数核对，不静默放行 |
| 复核被模型无脑确认 | 逐点验证退化为走过场，可验证性失守 | 须逐点回应才构成有效确认，空泛确认不被接受；确认留痕并标记「复核放行」；轮次上限后硬阻断并提示用户介入 |
| 设置服务未挂载或分节被清空 | 阈值与信号清单取不到值 | `installSection` 回退到组合配置与 schema 默认值，行为与不接设置时一致 |

**回滚**：D1 由阈值与开关控制，恢复原阈值即回到当前行为；D2–D4 位于 delivery 包族与 `tool-delivery`，卸载插件或 `enabled: false` 即移除；D5 为文档与快照。全部批次不修改 `agent-loop`，不改动既有 `delivery/change` 事件格式。

---

## 9. 已确认决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 规模分级判据 | 三层：字符地板（>200 → `l2`）→ 强信号扫描 → 模型 rubric；都不满足则自由执行。取「宁可升级」原则 |
| 2 | openspec 拆分形态 | openspec change 四件套（proposal/design/tasks/specs）+ `openspec validate --strict` 接入门禁 |
| 3 | 进度呈现 | 左侧悬浮卡片「阶段 + 子任务」双进度，阶段下展示该阶段子任务进度，阶段推进自动切换并展开 |
| 4 | 任务源 | `l2` 以 openspec `tasks.md` 为唯一任务源，`todo_write` 在 `l2` 下被拦截；`l0`/`l1` 保留 `todo_write` |
| 5 | `init` 的使用 | 不调用 `openspec init`，避免覆盖仓库根 `AGENTS.md` |
| 6 | 子任务进度数据源 | durable 事件承载上报，磁盘 `tasks.md` 在 `implemented` 处交叉核对 |
| 7 | L2 验证深度 | 结合 openspec task 与方案文档逐点验证：验证点清单程序化提取、`covers:` 双向索引、四层校验（覆盖完整性正向与反向、实现完成度、行为正确性），全过才允许 `accepted` |
| 8 | 校验坡度 | 程序化判断优先但不终结流程：初检发现差异即回注模型逐点复核，复核通过则放行；确认无实质内容、差异仍在或达复核轮次上限才硬阻断 |
| 9 | 可调项归属 | 阈值（200/60）与强/中/弱信号清单注册为设置服务的 `delivery` namespace，经 `installSection` 接线并保持无设置服务时的回退；后续在「设置」中统一管理 |
