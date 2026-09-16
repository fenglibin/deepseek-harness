# 交付纪律改造：分级、执行与实现验证的设计与技术决策

## 目标

让 L0/L1/L2 的需求分级、三级各自的分组执行路径、以及「实现验证」阶段，做到**可观测、可跟踪、可配置**，并确保最终交付结果的功能与逻辑正确性。本轮只产出设计，不改代码。

## 现状梳理

### 需求分级：两处串联 + 两条触发路径

分级逻辑不在一处，而是纯文本扫描与模型自报信号两层叠加：

| 位置 | 逻辑 |
|---|---|
| `packages/delivery/tool-delivery/src/grading.ts` | 目标长度 > `openspecThreshold.descriptionChars`（代码默认 **200**）直接 `l2`；命中任一强信号（约 40 个词，外加「≥3 条编号列表」）→ `l2`；中信号 ≥2 → `l2`；中信号 =1 或弱信号 ≥2 → `l1`；都不命中 → `l0` |
| `tool-delivery/src/index.ts` 的 `inferLevel()` | 在扫描之上叠加模型自报信号：扫描为 `l2` 则 `l2`；非小微 bug 过 design 阈值 → `l2`；`todoCount ≥ 15` 或目标长度 ≥ `specChars` → `l2`；扫描为 `l1`、或过 design 阈值（todo ≥ 5 / 文件 ≥ 3 / 长度 ≥ 60）→ `l1` |
| `agent/pre-step` 的 autoDetect | 对直接人类请求跑 `gradeObjective`，**只有 `l2` 才自动创建任务**；`l0`/`l1` 仅注入一次 `GRADING_RUBRIC` 提示，由模型自行决定是否创建任务及级别 |

### 三级的分组执行差异

三档只在**阶段序列**与**少量门禁**上不同，工具集完全一致（阶段序列表在 `packages/delivery/delivery/src/fold.ts` 与 `packages/client/ui-delivery/src/client/delivery-phases.ts` 两处各定义一份）：

| 等级 | 阶段序列 | 差异 |
|---|---|---|
| l0 | created → implemented → verified → accepted | 无 design/spec 要求 |
| l1 | created → **designed** → implemented → verified → accepted | 须 ≥1 条 `record_design` |
| l2 | created → designed → **specified** → implemented → verified → accepted | 须 ≥1 条 `record_spec`；`todo_write` 在 `stateful` 下被 `tools/pre-execute` 拒绝；`record_tasks` 须带合法 `change_id` 并同步写盘 `openspec/changes/<id>/tasks.md` |

关键不对称：**l2 禁用 `todo_write`，l1 允许**。

### 「实现验证」阶段实际做了什么

`advance_delivery_task(phase: 'verified')` 只做两件事：

1. `coverageGap()`：跑 `openspec show <changeId> --json`，从 `openspec/changes/<id>/` 的 delta spec 读 `#### Scenario:` 标题、从 `design.md` 读 `### D<n>` 标题，再检查 `tasks.md` 每行 checkbox 是否带 `(covers: ...)` 注解。**对 l1 完全失效**：l1 的 `changeId` 为空串，命令必然非零退出，函数直接返回 `undefined`。对 l2 也仅是形式检查，不验证实现是否真的做了。
2. 非 l2 时检查 `record_tasks` 的记录项是否全部 `completed`。**可整段跳过**：若任务从未调用 `record_tasks`，`recorded === undefined` 直接放行。

真正的命令级验证（`openspec validate <id> --strict --json` 与 `postHooks`）位于 `accepted` 阶段，不在 `verified`。

门禁的释放条件偏松：`coverageGap` 命中后，只要 `coverage_confirmation` 是一段 ≥20 字（`MIN_CONFIRMATION_CHARS = 20`）的文字，即记为一次 "coverage review" 并放行，最多允许 `maxReviewRounds`（默认 2）次；该计数使用模块级进程内 `Map`（`index.ts` 的 `reviewRounds`），不随会话隔离。

### 三个问题的根因

**问题 1：L1 的 TODO 进度不同步到左侧进度栏。**

左侧进度栏是 `DeliveryFloatCard`（槽位 `conversation.side.float`，挂在会话正文左边缘，**默认隐藏，需 Ctrl+Shift+P 唤出**）。任务列表的取值逻辑为：

```ts
const todoItems = items.length === 0 ? todos ?? [] : []
```

即 `delivery-tasks`（`record_tasks` 写入）一旦有记录，就完全不再读 `todos`。而 l1 下 `todo_write` 仍合法，模型可能先 `record_tasks` 建清单、之后一路只用 `todo_write` 推进，于是左侧卡片永久冻结在首次记录的状态。

两个加重因素：

- `todos` 投影的 fold 中 `if (event.type === 'turn/start') return null`，**每轮开始即清空**；未调 `record_tasks` 的 l1 任务，其列表在新一轮直接消失。
- `delivery-tasks` 投影**已算出按阶段聚合的 `progress: { done, total }`**（`packages/delivery/delivery/src/tasks-fold.ts`），但客户端一处未用；FloatCard 只平铺列表，连 items 自带的 `phase` 字段都未分组展示。

**问题 2：verified 阶段**对 l1 空转，对 l2 仅形式检查，且无产物证据。

**问题 3：抽插件 + 设置配置**——分级、执行门禁、实现验证已全部集中在 `tool-delivery` 一个包内；可配置性**已实现一半**：`installPolicy` 已通过 `settings.installSection(ctx, 'delivery', Config, ...)` 把整套策略注册进设置服务的 `delivery` namespace，组合配置为 base 层、用户覆盖实时生效。缺的只是设置界面——设置页按 namespace 派发 `settings.plugin.item` 插槽，当前没有任何客户端插件注册 `key: 'delivery'` 的卡片。

### 其他同等严重的问题

1. 任务列表有三个源并存且会漂移：`todos`（当轮、跨轮清空）、`delivery-tasks`（持久清单）、`openspec/.../tasks.md`（l2 的磁盘权威）。
2. 验证缺乏独立证据链：verified 的全部输入是模型自己写的 `status` 与 `covers` 注解，无任何来自实际产物（改动文件、测试结果）的证据。
3. `progress` 算了不用；`DeliveryTaskPanel`（聊天内时间线卡片）只显示事件流，不显示清单。

## 技术决策

### D1 任务列表统一到单一权威源 `delivery-tasks`

l1 保留 `todo_write`，但由 `delivery-tasks` 投影**直接 fold `todo/write` 事件**，使 `delivery-tasks` 成为唯一权威源，无须任何额外日志写入。

**机制修订记录。** 最初的设计是让 `tool-delivery` 监听 `session/event` 捕获 `todo/write`，再追加一条持久的 `delivery/tasks` 事件。该机制经实测**不可行**：`Session.append` 禁止重入（`packages/core/session/src/index.ts` 的 `if (entry?.appending) throw new Error('session append cannot reenter while another append is being published')`），而 `session/event` 监听器正是在 `appending = true` 期间被调用的，因此在回调内写日志必然抛错。实测输出为 `session append cannot reenter while another append is being published`，且 `delivery-tasks` 投影保持 `null`（写入完全失败）。

修订后的机制不需要任何写入：投影本就是 fold，`todo/write` 已在日志中，`delivery-tasks` 只需在同一 fold 内同时跟踪 `delivery/change`（取得当前任务等级）与 `todo/write`（取得清单），即可在零重入风险、零延迟的前提下完成镜像。

由此 `DeliveryFloatCard` 移除 `items.length === 0 ? todos ?? [] : []` 的双源择一逻辑，只读 `delivery-tasks`。

被放弃的方案：l1 也禁用 `todo_write` 强制 `record_tasks`（源唯一但模型须多调一个更重的工具）；保持双源仅改 UI 分别展示（漂移问题依旧，只是变得可见）；在 `agent/pre-step` 等 append 之外补写（可行但引入轮次延迟）。

### D2 实现验证改为「三类输入 + 确定性门禁 + 逐条对账」

verified 阶段的输入与检查固定为：

| 输入 | l0 | l1 | l2 |
|---|---|---|---|
| 原始需求（`objective`） | 必须 | 必须 | 必须 |
| 任务列表 | `delivery-tasks`（可空） | `delivery-tasks` | `openspec .../tasks.md`（权威） |
| 设计文档 | — | `.dsh/design/<id>.md` | 该文件 + `openspec/.../design.md` |

四道检查在 advance→verified 时执行：

1. **清单完整性**：权威源所有项 `completed`；l0/l1 缺清单时不再静默放行。
2. **覆盖性**：每条原始需求要点与每个 `### D<n>` 设计决策，都必须被至少一条已完成项声明覆盖；覆盖关系由 `covers:` 注解承载，l1 一并纳入。
3. **产物核验**：`openspec validate <id> --strict --json`（l2）与 `postHooks`（可配）**前移到 verified**，`accepted` 只做最终确认。
4. **逐条对账**：模型以结构化形式输出「原始需求第 N 条 → 实现位置/证据」，取代现行的 ≥20 字自由文本放行。

被放弃的方案：纯确定性门禁（完全依赖清单状态与注解，无法确认需求语义是否真的落地）；再加独立 verifier 子代理交叉验证（强度最高但引入额外模型成本与时延，可在后续按需追加）。

### D3 `reviewRounds` 从模块级 `Map` 改为按任务与阶段持久化

现行计数跨会话共享，应改为随任务状态（或会话投影）记录，使门禁轮次可跟踪且不互相污染。

### D4 配置界面：扩展设置卡片的字段控件

`card-form.ts` 当前仅有 `numberField` 与 `textField`，其 `FieldWrite` 已有 `set`/`clear` 抽象。据此：

| 配置项 | 控件 | 结论 |
|---|---|---|
| `descriptionChars`、`todoCount`、`touchedFiles`、`maxReviewRounds` | `numberField` | 直接可做 |
| `requireOpenspecForBugs`、`autoDetect` | 需新增布尔控件 | `textField` 只能写字符串，无法写 `true`/`false` |
| `enforcement` | 需新增枚举控件 | 三态枚举，同上 |
| `strongSignals` 等词表 | 需新增列表控件，或先按行解析多行文本 | 数组值当前无控件 |

新增控件是在既有 `FieldWrite` 抽象上的正常扩展，非绕过。

### D5 修正 `enforcement: off` 的加载期与运行期不一致

`apply()` 开头的 `if (!resolved.enabled || resolved.enforcement === 'off') return` 是加载期判定；`installPolicy` 的 `onChange` 只更新内存策略。用户在设置中选 `off` 时工具已注册、不会注销。此为**现存缺陷**，改造时须一并修正（或从设置界面的可选项中去掉 `off`，并明确记录该限制）。

### D6 可观测与可跟踪的落点

- FloatCard 的任务组改读 `delivery-tasks.progress`，按阶段分组显示 `done/total`，并标明当前权威源。
- 为进度面板提供常驻入口。当前"仅快捷键唤出、且可能显示过期数据"的表面不满足可观测诉求。
- 分级结果需可见：除等级徽章外，记录并展示**判定依据**（命中了哪些信号/哪个阈值），使分级可跟踪。
- 阶段序列 `LEVEL_PHASES` 目前在 host 与 client 各定义一份，应合并为单一来源。

### D7 分级误判的真正原因与阈值决策

**编号列表规则是主因，长度阈值是次因。** 实测证据：本次改造的原始请求（410 字符）在 `specChars` 取 200、300、600、1200 四档时，取 200/300/1200 均判定为 `l2`，仅 600 为 `l1`。即**调高长度阈值并不能修正该误判**。

真正的主导规则是 `scanSignals` 中的：

```ts
const decomposable = numberedItemCount(objective) >= DECOMPOSABLE_ITEMS ? 1 : 0
return { strong: countHits(text, policy.strongSignals) + decomposable, ... }
```

配合 `gradeObjective` 的 `if (hits.strong > 0) return 'l2'`，结论是：**任何包含 3 条及以上编号项的需求，无论多短、无论阈值多高，一律判定为 `l2`**。实测一段仅 26 字符、不含任何信号词的文本 `"1、修复登录按钮\n2、修复注册按钮\n3、修复退出按钮"` 即被判为 `l2`。

而"列出 3 条问题或要求"是提出需求最常见的书写形式，因此该规则的误判面远大于长度阈值。

决策：把编号列表规则表达的"可拆分"语义与"规模大"区分开。可拆分对应 `l1`（出设计文档），而非 `l2`（出 OpenSpec 四件套）。故将该信号由 strong 降级为 medium：3 条编号单独命中计 `l1`，与其它 medium 信号叠加达 2 个时才升 `l2`。

长度阈值在该规则修正后才成为有效的主导因素，其取值需与部署对 l2 成本的偏好一并确定：`l2` 强制 OpenSpec 四件套，token 成本高但留痕完整；`l1` 仅需设计文档，成本低但拆分管得松。待定。

强信号词表中的「重构 / 迁移 / 优化 / 替换」等高频词同样偏激进，需一并收窄或改为组合命中。

### D8 l1 纳入自动创建

`l2` 由 autoDetect 自动创建，`l1` 完全依赖模型自愿调用 `create_delivery_task`；模型不创建则不存在交付任务，左侧进度卡片也不存在。这使 l1 这一档在实际上缺少确定性的产生路径。

决策：判定为 `l1` 时同样自动创建任务，使交付纪律覆盖所有非小微需求。`l0` 仍保持自由执行。

### D9 分层边界：包内分层 + 独立客户端设置卡片包

分级（`grading.ts`）、分组执行门禁、实现验证目前已集中在 `tool-delivery` 一个包内。决策是不拆为三个独立包，而是在 `tool-delivery` 内按模块分层，另新增一个客户端设置卡片包（注册 `settings.plugin.item` 中 `key: 'delivery'` 的卡片）。

理由：三个关注点当前共享同一份 `ResolvedConfig` 与同一套工具注册流程，拆包会引入跨包契约与新的 capability seam，而收益仅是形式上的边界清晰；分层已能达到可测试、可独立演进的目标。若后续分级策略需要被其他部署替换实现，再按需抽出。

## 治理发现：既有 change 的完成状态不可信

`openspec/changes/add-delivery-openspec-split/tasks.md` 的五组任务全部标记为 `[x]` 完成，但其 D3「双进度呈现」要求的"悬浮卡片在阶段条每个节点下显示该阶段子任务完成度"，在当前代码中并不存在。

实际情况是：`DeliveryFloatCard` 只实现了按语义四组（需求分析 / 设计文档 / 任务列表 / 实现验证）的展示——那是 `add-delivery-analysis-progress` 的 D3。而"按阶段分组显示 `done/total`"这一能力从未落地，`delivery-tasks` 投影算出的 `progress` 字段在客户端一处未用。

这不是孤立的文档问题，而是对本次核心诉求「确保最终结果交付的功能及逻辑的正确性」的直接证据：**当前这套交付纪律自身无法保证其声明的完成度与实际代码一致**。它同时解释了用户反馈的问题 1 —— 即便 `delivery-tasks` 已携带分阶段进度数据，UI 也从未按阶段呈现。

因此 D2 的"覆盖性检查"必须落实为对**产物**的核验，而不只是对模型自报状态的核验；否则本次改造会重复同一个失败模式。

## 开放问题

1. **`specChars` 与信号词表的具体新默认值**需要在实施时用真实中文需求文本回归确定，而非拍定一个数字。
2. **`enforcement: off` 的处置**：是修正为运行期可注销，还是从设置界面可选项中移除 `off` 并记录该限制（见 D5）。
3. **设置卡片的词表控件形态**：新增列表控件，还是先用多行文本按行解析（见 D4）。

## 实施阶段建议

1. 阶段一（缺陷修复）：D1 源统一、`LEVEL_PHASES` 单源、D5 的 `off` 不一致。
2. 阶段二（分级修正）：D7 阈值与词表、D8 的 l1 自动创建。
3. 阶段三（验证重建）：D2 四道检查、D3 计数持久化。
4. 阶段四（可配置）：D4 控件扩展、D9 设置卡片包落地。
5. 阶段五（可观测）：D6 进度分组、常驻入口、分级依据展示。
