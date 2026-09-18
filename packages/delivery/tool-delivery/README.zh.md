---
description: "模型侧交付纪律工具：在可配置门禁强度下创建、读取、记录变更、设计与 spec 并推进同会话交付任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-delivery

## 概述

`dsh-tool-delivery` 为模型提供七个操作持久化同会话交付任务的工具：`get_delivery_task` 读取当前任务，`create_delivery_task` 创建任务（长度闸门加一次分级模型调用），`record_change` 记录一条变更，`mark_analysis_done` 标记需求分析完成，`record_design` 记录一条设计，`record_spec` 记录一条 spec，`record_tasks` 记录实施清单，`advance_delivery_task` 推进阶段。门禁强度是部署选择：`stateful`（默认）在至少存在一条变更记录之前阻止推进到 `implemented`，在至少存在一条设计记录之前阻止推进到 `designed`，在至少存在一条 spec 记录之前阻止推进到 `specified`；`advisory` 只提醒而不阻止，`off`（或 `enabled: false`）完全不注册工具。当 agent 应当保持一个可见、可追溯变更并按纪律生命周期推进的任务时选择它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把它与交付服务和工具注册表一起挂载；工具随后出现在对话中。

```yaml
- name: '@deepseek-ai/dsh-delivery'
- name: '@deepseek-ai/dsh-tool-delivery'
  config:
    enforcement: stateful
    designThreshold:
      todoCount: 5
      descriptionChars: 60
      touchedFiles: 3
    openspecThreshold:
      todoCount: 15
      descriptionChars: 200
    requireOpenspecForBugs: true
    verificationCommands:
      - smoke
      - docs
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否注册工具 |
| `enforcement` | `stateful` | `stateful` 阻止、`advisory` 提醒、`off` 不注册 |
| `designThreshold.todoCount` | `5` | 预估 todo 数达到或超过该值时自动分级为 `l1` |
| `designThreshold.touchedFiles` | `3` | 预估改动文件数达到或超过该值时自动分级为 `l1` |
| `openspecThreshold.todoCount` | `15` | 预估 todo 数达到或超过该值时自动分级为 `l2` |
| `openspecThreshold.descriptionChars` | `200` | 目标长度超过该值时直接分级为 `l2`，不再调用分级模型 |
| `requireOpenspecForBugs` | `true` | 非小微 bug 修复（预估规模达到 design 阈值）强制 `l2` |
| `verificationCommands` | `[]` | 要求任务在执行时留下记录的验收命令名（对应 `prompt-commands` 命名空间的条目名）；缺少记录即阻止推进到 `verified` |
| `gradingPrompt` | 内置规则文本 | 分级判定的系统提示词；判定由一次独立模型调用执行，模型只回一个分级标签 |
| `autoDetect` | `true` | 直接人类请求判定为 `l0`/`l1`/`l2` 时一律自动创建任务；判定为 `l0` 时另注入一次分级判据，供模型按内容提高分级 |
| `maxReviewRounds` | `2` | 门禁差异允许的模型复核轮次，超过即硬阻断 |

阈值、分级规则与验收清单同时注册为设置服务的 `delivery` namespace：组合配置作为 `base` 层，用户覆盖优先且实时生效；未挂载设置服务时回退到组合配置，行为不变。该 namespace 配有设置界面（`设置 → 插件 → 插件配置 → 交付纪律`），可编辑上表的全部字段，含布尔、枚举、数值与多行文本控件。

### 每次调用的作用

- 直接人类请求到达时 `autoDetect` 先定级、再创建任务，使交付纪律覆盖每一次直接请求。定级分两步：目标长度超过 `openspecThreshold.descriptionChars` 时直接为 `l2`，否则发一次分级模型调用（系统提示词即 `gradingPrompt`，模型只回一个分级标签）。**判定用模型而不是关键词表**：忽略大小写的子串匹配无法区分「改 auth.ts 里的注释」与「改 auth 协议」，任何词表都会同时漏判（「表演示一下这个界面」只命中一个弱信号仍是 `l0`）与误判（文件名里的 `auth` 把改注释抬成 `l2`）。分级失败——没有可用路由、调用报错、超时或响应里没有分级标签——一律回退 `l1`：与其放行一个未判定的请求，不如让它留下一条设计记录。**判定不阻塞步骤**：`pre-step` 立即放行，判定作为后台任务推进，落地时才建任务并补记依据；`user/message` 只在 `pre-step` waterfall 解析之后 append，在步骤里 `await` 判定会让用户自己的消息在整个判定期间不进入 transcript。每个会话至多一个判定在跑，期间的第二次请求被记为待续而非丢弃；落地时重读当前任务，模型在此期间自建的任务不会被覆盖。
- 分级调用是一个独立的模型调用，因此按「模型可见 ⟺ 已记录」写入 `delivery/grading-request` 会话事件（含路由、系统提示词、消息与输出上限）。路由优先级为 `lightweightModel` 设置 → 会话最近一次请求头路由 → agent 自身路由。
- **已 `accepted` 的任务会让位，未完成的 `l0` 会被替换。** `DeliveryService.create` 允许在 `accepted` 任务之后新建——它已经完成、不再占用会话——因此那种情形直接新建，不写 tombstone。其余情形由策略决定：未完成的 `l0` 是彼此独立的小微修复，`pre-step` 在创建下一个任务前先 `clear` 掉它（`clear` 留下 durable tombstone，被替换的任务仍可追溯）；未完成的 `l1`/`l2` 保留占用，较大的工作需要跨 turn 的连续性。两者都不放行会让会话永久占死：没有任何工具可以清空任务，于是后续每个请求都被拒绝，并在没有任何交付任务的情况下运行。代价是 `l0` 的自检保护为尽力而为——同一 turn 内没走完 `verified` 时，那次自检不会被门禁强制。
- `create_delivery_task` 以目标和可选 `level`（`l0`/`l1`/`l2`）在 `created` 阶段启动一个任务；省略 `level` 时走与自动路径相同的判定：长度闸门优先，否则问分级模型，再由模型自估值与 bug 策略抬高。显式给出 `level` 时不发分级调用，也不记录分级依据。当前任务是 `l0` 或已 `accepted` 时该调用会替换它，未完成的 `l1`/`l2` 仍须先推进或清空。
- **模型的规模自估值只能抬高分级，不能压低。** `todo_count`／`touched_files`／`is_bug` 由模型在创建任务时给出，达到 `openspecThreshold.todoCount` 即为 `l2`、达到 L1 阈值即为 `l1`；`requireOpenspecForBugs` 开启时，非小微 bug 直接为 `l2`。这些判据全是确定性比较，但都只在分级结果之上加码，因此一个自己判断需要设计的模型不会被一个偏小的估值降级。
- `record_change` 针对精确的 `{ task_id, revision }` 记录一条变更（`text`），递增变更数，并把记录追加到 `.dsh/changes/<task-id>.md`。
- `mark_analysis_done` 针对精确的 `{ task_id, revision }` 标记需求分析已完成。任务创建后应先澄清并对齐需求，再调用它；`record_design` 在分析完成前会被阻止。
- `record_design` 针对精确的 `{ task_id, revision }` 记录一条设计（`text`），递增设计数，并把记录追加到 `.dsh/design/<task-id>.md`。
- `record_spec` 针对精确的 `{ task_id, revision }` 记录一份 OpenSpec 变更产物（`text`），递增 spec 数，并覆盖写入 `openspec/changes/<change_id>/` 下的 `proposal.md`、`design.md`、`tasks.md` 或 `specs/<capability>/spec.md`（由 `kind` 决定）；`change_id` 必须是动词开头的 kebab-case。四件套以覆盖方式写入，因为 OpenSpec 会结构化解析 `tasks.md` 与增量 spec。
- `record_tasks` 针对精确的 `{ task_id, revision }` 记录完整的实施清单（`items`），整体替换此前记录过的清单；每项为 `{ content, phase, status }`，`status` 为 `pending`/`in_progress`/`completed` 三态。非 `l2` 任务的 `change_id` 传空字符串；`l2` 任务仍须 kebab-case。该清单驱动分阶段进度展示，并在推进 `implemented` 前与 `openspec/changes/<change_id>/tasks.md` 交叉核对。
- `advance_delivery_task` 把任务推进到其分级唯一合法的下一阶段；跳步会被拒绝。
- `get_delivery_task` 读取当前任务，包含其精确的 id/revision。

在 `stateful` 下，直到至少存在一条变更记录之前，推进到 `implemented` 会被阻止；直到至少存在一条设计记录之前，推进到 `designed` 会被阻止；直到至少存在一条 spec 记录之前，推进到 `specified` 会被阻止。在 `advisory` 下，同样的条件会产出一条对话内提醒但不阻止。`enforcement` 每次判定时读取，因此在设置中改为 `off` 会立即解除后续推进的门禁。

### 实现验证

推进到 `verified` 时按**原始需求、任务列表、设计文档**三类输入执行四道检查：

1. **清单完整性**——权威任务列表（`l2` 为磁盘 `tasks.md`，`l1` 为 `delivery-tasks` 投影）的每一项都必须是 `completed`；`l1` 未记录清单会被阻止，`l0` 没有清单义务故豁免。`l0` 现在也创建任务并经过这道门禁，但其豁免不变：小微修复不因纳入验收而承担清单与 `covers` 注解的负担，因此 `l0` 走的是「验收命令」这一道而非全部四道。
2. **覆盖性**——原始需求的每条编号项与设计文档的每个 `### D<n>` 决策，都必须被一条**已完成**清单项通过行尾 `(covers: <key>)` 注解声明覆盖。键名为 `req/<n>`、`design/<Dn>`，`l2` 另含 `<capability>/<Scenario name>`。
3. **产物核验**——`l2` 先执行 `openspec validate <change_id> --strict --json`，任一非零退出、超时或中止都会阻止验证，且不因模型确认完成而豁免。配置的验收命令是提示词命令（正文由模型执行），没有退出码可判，因此改为校验该任务是否为每条命令留下了执行记录：模型须为每条命令调用 `record_change`，记录文本以 `acceptance: <命令名> ` 开头（例如 `acceptance: smoke 全部通过`），命令名不带前导斜杠。
   **顺序是机械要求。** 门禁每次只要求配置顺序中**最早**那条尚未记录的命令，并在消息里说明它是第几条、共几条，因此模型无法跳到后面某条，也无法一次声称全部完成。为第二条命令留下记录而不记录第一条，推进仍会被阻止。命令名在 `prompt-commands` 命名空间中已不存在时，门禁照常阻止并说明该命令没有对应的提示词。
4. **逐条对账**——覆盖关系由上述注解承载，取代一段自由文本放行。

第 1、3 道为确定性判定；第 2 道允许在 `maxReviewRounds` 轮次内由一段具体说明（`coverage_confirmation`，至少 20 字）放行并留痕，轮次按当前任务从会话日志计数。`accepted` 只做最终确认，不再重复执行验证命令。

`l1` 任务的清单由 `todo_write` 镜像而来：`delivery-tasks` 投影自身 fold `todo/write`（投影状态自持当前任务的 `level` 与 `phase`），因此 l1 无需额外调用 `record_tasks`，且镜像不写入会话日志、不受 append 重入约束。镜像视图带 `source: 'mirrored'` 标记，进度面板据此显示来源；已记录的 `l2` 清单不会被镜像覆盖。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

### 设计

- **服务支撑、策略自有门禁。** 这些工具是 `ctx.delivery` 之上的薄适配器；阶段顺序校验位于领域层，而变更与设计记录前置条件及规模分级是 `apply` 中解析的部署策略，在 `advance` 之前检查（分级在 `create` 时检查）。
- **失败即报错的配置。** `enabled` 与 `enforcement` 在 `apply` 时校验；未知的 enforcement 值直接抛出，而不是静默取默认值。
- **无独立状态。** 这些工具不拥有任何 durable 状态；交付领域及其严格回放是唯一权威。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、工具注册、分级推断与门禁编排 |
| [`src/verification.ts`](src/verification.ts) | 实现验证：清单完整性、覆盖性、产物核验与复核轮次计数 |
| [`src/grading.ts`](src/grading.ts) | 长度闸门与分级响应解析（不依赖 cordis，可独立测试） |
| [`src/coverage.ts`](src/coverage.ts) | 覆盖点提取与比对：`#### Scenario:`、`### D<n>`、原始需求编号项与 `covers:` 注解解析 |
| [`src/openspec.ts`](src/openspec.ts) | OpenSpec change 布局：change-id 校验与四件套路径推导 |
| [`src/invariant.ts`](src/invariant.ts) | 无运行时 invariant companion |

设置界面位于 [`packages/client/ui-settings-plugins`](../../client/ui-settings-plugins/README.zh.md)：`delivery-card-controller.ts` 与 `DeliveryCard.tsx` 注册命名空间为 `delivery` 的卡片，其布尔、枚举与列表控件由同包的 `card-form.ts` / `fields.tsx` 提供。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema 与结果

#### 模型看到什么

生成的 [`get_delivery_task`、`create_delivery_task`、`record_change`、`mark_analysis_done`、`record_design`、`record_spec`、`record_tasks` 与 `advance_delivery_task` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-delivery)。每个都返回一个紧凑 JSON 对象：任务不存在时为 `{ task: null }`，否则为 `{ task: { id, revision, objective, phase, level, changeCount, designCount, specCount, analysisDone, createdAt, updatedAt } }`。

#### token 影响

每次执行的工具都通过普通的 tool-result 管线追加其数据相关的 JSON 结果；没有私有截断。

#### KV 缓存影响

只要定义与作用域保持不变，schema 就保持前缀稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了这些工具何时不适用。它们是当前的包约束，不是任务待办。

- **记录以 durable 事件 + `.dsh/`/`openspec/` 文件持久化** — `record_change` 与 `record_design` 追加到 `.dsh/changes/<task-id>.md` 与 `.dsh/design/<task-id>.md`；`record_spec` 覆盖写入 `openspec/changes/<change_id>/` 下的四件套；`record_tasks` 把实施清单写入 durable `delivery/tasks` 事件，后者整体替换前一份清单。
- **门禁是逐次 advance 而非持续监控** — 在门禁策略变更之前创建的任务，只在其下一次 `advance` 时被重新检查。
- **仅单一 owner 作用域** — 任务属于一个 agent 会话；子代理与共享作用域不在范围内。
- **`enabled: false` 与 `enforcement: off` 不同** — 前者在加载期就不注册任何工具，因此设置界面无从关闭它；后者注册工具但在每次判定时短路，可在设置中实时切换。要彻底不暴露工具，只能在组合配置中设 `enabled: false`。
- **`l0` 不参与注解覆盖** — `l0` 没有清单义务，因此其原始需求（即使写成编号列表）不要求 `covers:` 声明；对它而言纪律就是请求本身。这是刻意的：一段「1、修复甲 2、修复乙」的小微修复若被要求逐项注解，会在没有清单可承载时永久卡在验证。`l0` 仍然经过「验收命令」这一道门禁。
- **`l0` 的自检是尽力而为的** — 未完成的 `l0` 任务会被下一条直接请求替换，因此同一个 turn 内没有走完 `verified` 的任务，其验收命令门禁不会被执行。让 `l0` 保持轻量的代价；`l1`/`l2` 的门禁仍是硬的。
- **镜像清单不做注解校验的来源区分** — 由 `todo_write` 镜像而来的 `l1` 清单同样需要 `covers:` 注解（写在 todo 项内容里）。镜像只在 l1 任务存续期间发生，且已记录的 `l2` 清单不会被镜像覆盖。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
