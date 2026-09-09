---
description: "模型侧交付纪律工具：在可配置门禁强度下创建、读取、记录变更、设计与 spec 并推进同会话交付任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-delivery

## 概述

`dsh-tool-delivery` 为模型提供七个操作持久化同会话交付任务的工具：`get_delivery_task` 读取当前任务，`create_delivery_task` 创建任务（根据目标长度自动分级），`record_change` 记录一条变更，`mark_analysis_done` 标记需求分析完成，`record_design` 记录一条设计，`record_spec` 记录一条 spec，`record_tasks` 记录实施清单，`advance_delivery_task` 推进阶段。门禁强度是部署选择：`stateful`（默认）在至少存在一条变更记录之前阻止推进到 `implemented`，在至少存在一条设计记录之前阻止推进到 `designed`，在至少存在一条 spec 记录之前阻止推进到 `specified`；`advisory` 只提醒而不阻止，`off`（或 `enabled: false`）完全不注册工具。当 agent 应当保持一个可见、可追溯变更并按纪律生命周期推进的任务时选择它。

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
      descriptionChars: 300
      touchedFiles: 3
    openspecThreshold:
      todoCount: 15
      descriptionChars: 1200
    requireOpenspecForBugs: true
    postHooks:
      - 'openspec validate --strict'
      - 'pnpm run test'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否注册工具 |
| `enforcement` | `stateful` | `stateful` 阻止、`advisory` 提醒、`off` 不注册 |
| `designThreshold.todoCount` | `5` | 预估 todo 数达到或超过该值时自动分级为 `l1` |
| `designThreshold.descriptionChars` | `60` | 目标长度达到或超过该值时自动分级为 `l1` |
| `designThreshold.touchedFiles` | `3` | 预估改动文件数达到或超过该值时自动分级为 `l1` |
| `openspecThreshold.todoCount` | `15` | 预估 todo 数达到或超过该值时自动分级为 `l2` |
| `openspecThreshold.descriptionChars` | `200` | 目标长度超过该值时直接分级为 `l2`，不再扫描信号 |
| `requireOpenspecForBugs` | `true` | 非小微 bug 修复（超过 design 阈值）强制 `l2` |
| `postHooks` | `[]` | 任务到达 accepted 之前按序执行的后置命令 |
| `strongSignals` | 内置词表 | 命中任一即分级为 `l2` 的模式（关键词或路径片段） |
| `mediumSignals` | 内置词表 | 命中两个分级为 `l2`、命中一个分级为 `l1` 的模式 |
| `weakSignals` | 内置词表 | 命中两个分级为 `l1` 的模式 |
| `maxReviewRounds` | `2` | 门禁差异允许的模型复核轮次，超过即硬阻断 |

阈值与信号清单同时注册为设置服务的 `delivery` namespace：组合配置作为 `base` 层，用户覆盖优先且实时生效；未挂载设置服务时回退到组合配置，行为不变。

### 每次调用的作用

- `create_delivery_task` 以目标和可选 `level`（`l0`/`l1`/`l2`）在 `created` 阶段启动一个任务；省略 `level` 时按三层判定推断：目标长度超过 `openspecThreshold.descriptionChars` 直接为 `l2`，否则扫描强/中/弱信号——命中任一强信号为 `l2`，命中一个中等信号或两个弱信号为 `l1`，都不命中为 `l0`；bug（`is_bug`）可能强制 `l2`。
- `record_change` 针对精确的 `{ task_id, revision }` 记录一条变更（`text`），递增变更数，并把记录追加到 `.dsh/changes/<task-id>.md`。
- `mark_analysis_done` 针对精确的 `{ task_id, revision }` 标记需求分析已完成。任务创建后应先澄清并对齐需求，再调用它；`record_design` 在分析完成前会被阻止。
- `record_design` 针对精确的 `{ task_id, revision }` 记录一条设计（`text`），递增设计数，并把记录追加到 `.dsh/design/<task-id>.md`。
- `record_spec` 针对精确的 `{ task_id, revision }` 记录一份 OpenSpec 变更产物（`text`），递增 spec 数，并覆盖写入 `openspec/changes/<change_id>/` 下的 `proposal.md`、`design.md`、`tasks.md` 或 `specs/<capability>/spec.md`（由 `kind` 决定）；`change_id` 必须是动词开头的 kebab-case。四件套以覆盖方式写入，因为 OpenSpec 会结构化解析 `tasks.md` 与增量 spec。
- `record_tasks` 针对精确的 `{ task_id, revision }` 记录完整的实施清单（`items`），整体替换此前记录过的清单；每项为 `{ content, phase, status }`，`status` 为 `pending`/`in_progress`/`completed` 三态。非 `l2` 任务的 `change_id` 传空字符串；`l2` 任务仍须 kebab-case。该清单驱动分阶段进度展示，并在推进 `implemented` 前与 `openspec/changes/<change_id>/tasks.md` 交叉核对。
- `advance_delivery_task` 把任务推进到其分级唯一合法的下一阶段；跳步会被拒绝。
- `get_delivery_task` 读取当前任务，包含其精确的 id/revision。

在 `stateful` 下，直到至少存在一条变更记录之前，推进到 `implemented` 会被阻止；直到至少存在一条设计记录之前，推进到 `designed` 会被阻止；直到至少存在一条 spec 记录之前，推进到 `specified` 会被阻止。在 `advisory` 下，同样的条件会产出一条对话内提醒但不阻止。

在任务到达 `accepted` 之前，每个配置的 `postHooks` 命令都会按序在会话工作目录下执行。`stateful` 下任何非零退出、超时或中止都会阻止验收；`advisory` 下失败只会以提醒形式呈现，验收仍会继续。

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
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、工具注册、门禁逻辑 |
| [`src/invariant.ts`](src/invariant.ts) | 无运行时 invariant companion |

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

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
