---
description: "持久化的同会话交付纪律任务服务：为每个会话维护一个可追溯变更记录的交付任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-delivery

## 概述

`dsh-delivery` 为每个 agent 会话维护一个持久化的交付任务：任务的目标、规模分级（`l0` 小微修复、`l1` 增加设计、`l2` 增加 openspec 拆分）、生命周期阶段、以及已记录的变更数都存放在会话日志中，因此可跨会话恢复、fork 与进程重启存续。你可以创建、推进、记录变更、清除任务，且每次变更都是比较并设置，陈旧的视图不会覆盖更新的状态。任务只能沿其分级规定的阶段顺序前进——`created → designed → specified → implemented → verified → accepted`——跳过必需阶段会被拒绝。它是状态而非策略：服务强制阶段顺序，而模型侧的门禁强度（`stateful` / `advisory` / `off`）属于 `dsh-tool-delivery`。当一项具体工作应当产出变更记录并按纪律生命周期推进时选择它；常规单轮工作不要使用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当会话需要在多轮与多次重启之间记住一个可追溯变更的交付任务时，挂载 `dsh-delivery`。本包是服务：模型工具是消费同一任务状态的独立包，因此只挂载本包只会存储和提供任务，不会暴露任何工具。

### 何时使用

任务适合一项应当产出至少一条变更记录并按阶段顺序推进的具体工作。常规单轮工作不应创建任务。服务每会话至多保留一个当前任务：未完成的任务必须先推进或清除，才能被另一个替代；已验收的任务可以直接被替换。

### 挂载

通过组合配置项加载本包；它不接受配置。

```yaml
- name: '@deepseek-ai/dsh-delivery'
```

### 会话投影

`DeliveryService` 要求 `ctx.sessionProjections`（[`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.zh.md)），并在启动时注册 `delivery` 投影单元；未组合投影注册表的组合无法激活 `ctx.delivery`。

### 任务生命周期

任务按分级经历这些持久阶段：

| 分级 | 阶段顺序 |
|---|---|
| `l0` | `created → implemented → verified → accepted` |
| `l1` | `created → designed → implemented → verified → accepted` |
| `l2` | `created → designed → specified → implemented → verified → accepted` |

动词如下：

| 操作 | 作用 |
|---|---|
| `create` | 以目标和可选分级启动一个 `created` 任务 |
| `recordChange` | 记录一条变更并递增变更数，不改变阶段 |
| `recordDesign` | 记录一条设计并递增设计数，不改变阶段 |
| `recordSpec` | 记录一条 spec 并递增 spec 数，不改变阶段 |
| `advance` | 推进到该分级唯一合法的下一阶段 |
| `clear` | 移除当前任务；其历史保留在会话日志中 |

### 观察任务

消费者通过 `ctx.delivery.get(agent)` 读取当前任务并得到一个分离视图：目标、阶段、分级、变更数、设计数与 spec 数及时间戳。变更必须携带该视图返回的精确 `{ id, revision }`，因此持有较旧状态的消费者会收到明确的陈旧 revision 错误，而不是静默覆盖更新的状态：

```text
const view = ctx.delivery.get(agent)      // undefined when no task is current
view.phase                               // one of the six lifecycle phases
view.level                               // 'l0' | 'l1' | 'l2'
view.changeCount                         // number of recorded changes
view.designCount                         // number of recorded designs
view.specCount                           // number of recorded specs
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

### 设计

- **事件溯源状态。** 每项变更都追加一个 durable `delivery/change` 事件（版本 1），携带完整的变更后快照、一条增量变更记录或一条清除墓碑。会话日志是唯一的持久权威。
- **比较并设置变更。** `ctx.delivery` 只接受以其 id 注册的精确存活 `Agent`。`get()` 返回分离视图；变更接受 `DeliveryTaskRef { id, revision }` 并拒绝陈旧引用。
- **仅前向阶段顺序。** fold 校验每次 `advance` 都推进到该任务分级唯一合法的下一阶段，并在回放时拒绝跳过的阶段。
- **严格回放。** fold 仅从 `delivery/change` 推导当前任务，并拒绝畸形结构、不连续 revision、非法阶段跳转、非单调时间戳与复用 id。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`DeliveryService`、投影单元、变更操作 |
| [`src/types.ts`](src/types.ts) | 纯客户端安全类型：`DeliveryView`、投影键声明 |
| [`src/domain.ts`](src/domain.ts) | durable 变更载荷、`delivery/changed` 事件 |
| [`src/fold.ts`](src/fold.ts) | 严格回放 fold 与 durable delivery 变更解码器 |
| [`src/runtime.ts`](src/runtime.ts) | `DeliveryTaskId` 品牌、`DeliveryError` 代码、变更版本 |
| [`src/invariant.ts`](src/invariant.ts) | invariant companion：对每个已挂载会话的独立增量 fold |
| [`src/client.ts`](src/client.ts) | 类型出口的客户端命名空间再导出 |

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 任务状态变更

#### 模型看到什么

交付任务变更不注入模型上下文。`dsh-tool-delivery` 中的模型工具返回当前任务状态，投影将其暴露给宿主消费者。

#### token 影响

交付任务变更事件本身不增加模型 token。工具结果自行承担其可见状态的开销。

#### KV 缓存影响

在另一个组件把任务状态暴露到模型可见输入之前，没有 KV 缓存影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了交付服务何时不适用或需要特别留意。它们是当前的包约束，不是任务待办。

- **单个当前任务** — 并行目标与独立的任务库刻意缺失；替换或清除后历史仍可从会话日志追溯。
- **状态而非策略** — 本包强制阶段顺序，但不决定任务何时推进、不重试失败、也不要求在 `implemented` 之前存在变更记录；这些策略属于 `dsh-tool-delivery`。
- **无产物持久化** — 变更记录仅以 durable 事件存在；写 `.dsh/changes/` 文件是后续消费者的职责。
- **受信的进程内生产者** — 拥有 `Session` 直接访问权的插件可以伪造 `delivery/change` 数据。严格回放会检测畸形或不一致的记录，并在该记录处让交付访问失败，直到日志被修复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
