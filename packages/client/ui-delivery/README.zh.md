---
description: "Web GUI 的交付纪律界面：会话中的一个持久任务时间线卡片，加上一个固定在正文左边缘的悬浮任务卡片，展示当前任务的规模分级、生命周期阶段、变更时间线与已产出的产物路径；面向交付纪律体验的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-delivery

[English](README.md) | 中文

## 概述

本包在 Web GUI 中以两个只读视图渲染交付纪律界面。持久**时间线卡片**把 `delivery/change` 会话事件折叠为一个 keyed Conversation 节点，因此任务卡片在其 create 事件处出现在转录中，并在每次变更（阶段转换与每条变更/设计/拆分记录）时重新渲染。**悬浮卡片**固定在会话正文左边缘，展示当前任务的规模分级（`L0`/`L1`/`L2`）、其阶段、截断的目标，展开后还展示其分级所要求阶段（`created` → … → `accepted`）的进度条与 record 工具迄今已写入的产物路径（`.dsh/changes/<id>.md`、`.dsh/design/<id>.md`、`openspec/changes/<id>/spec.md`）。悬浮卡片从 host 计算的 `delivery` 投影读取实时任务；两个视图均为只读——任务通过模型侧工具推进。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件与 `ui-conversation` 以及 `@deepseek-ai/dsh-delivery` 领域包一起挂载。时间线卡片随后出现在转录中模型创建的每个交付任务处；当会话存在当前任务时，悬浮卡片出现在会话正文左边缘。加载中与无当前任务都不渲染，因此不在交付纪律中的会话不会显示额外界面。

### 时间线卡片

卡片在转录中跟随任务生命周期：`create` 打开它，每个 `advance` / `record-change` / `record-design` / `record-spec` / `clear` 追加一条时间线条目，因此阶段进度与记录计数随模型工作实时更新。

### 悬浮卡片、阶段进度与门禁提示

悬浮卡片展示一个进度条，精确覆盖该任务分级所要求的阶段（L0 跳过设计与拆分、L1 跳过拆分、L2 走完整顺序），并标记已完成、当前与即将到来的步骤。当下一阶段的前置记录缺失时，门禁提示会说明接下来需要什么（变更、设计或 spec）。

### 产物列表

仅当至少存在一条记录时悬浮卡片才列出产物路径，由任务的 `changeCount`/`designCount`/`specCount` 推导。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

时间线卡片是事件模式的：`deliveryTaskDefinition` 把 `delivery/change` 会话事件折叠为一个 keyed Chat 节点，注册在 `conversation.chat.node` 上。悬浮卡片是投影模式的：实时任务通过 `useProjection('delivery')` 到达（由历史尾页 seed，并由 `session/projection` 帧更新），注册在 session 作用域的 `conversation.side.float` 槽上。产物路径由投影快照的记录计数推导，因此插件不拥有 durable 状态、也不发出事件；卸载随插件 fiber（HMR 安全）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当交付条带不够时阅读这些页面。

- [dsh-delivery](../../delivery/delivery/README.zh.md) — 此界面读取的交付领域、投影与生命周期。
- [dsh-tool-delivery](../../delivery/tool-delivery/README.zh.md) — 推进任务并写入产物的模型侧工具。
- [ui-conversation](../ui-conversation/README.zh.md) — 声明 `conversation.side.float` 与 `conversation.chat.node` 槽位并拥有 composer。
- [客户端包地图](../README.zh.md) — 相邻的浏览器 UI 包。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了当前的交付界面。它们是当前包约束，不是任务待办。

- **仅推导产物** — 界面从记录计数重建产物路径；没有 `delivery/artifact-written` 会话事件，因此模型在 record 工具之外写入的产物（例如手写的 `openspec/` change）不会被列出。
- **无门禁通过/失败或后置命令时间线条目** — 时间线卡片展示创建、阶段转换与每条记录，但门禁通过/失败与后置命令结果尚未渲染为节点；这些节点要回放的事件尚非 durable。
- **无产物内容预览** — 界面列出路径而非只读文件内容；内容预览需要 host 把 `fs` 读取投影到客户端。
- **无配置设置卡片** — 阈值、开关与 `postHooks` 尚不能从设置界面编辑。
- **只读界面** — 任务通过模型侧工具推进，而非此界面；这里没有 accept/clear/advance 动词。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
