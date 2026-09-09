---
description: "通过作用域交互路径响应 Host 权限请求的浏览器批准界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-approval

## 概述

`dsh-client-ui-approval` 提供基于 Agent-scoped Remote Event waterfall 的浏览器审批界面。插件通过 `ctx.uiSession` 发布每个待处理请求、接管 Conversation composer、按需渲染关联的 Tool 详情，并将用户决定返回给等待中的 Host 请求。当浏览器必须为等待中的 Host 操作收集批准时，请使用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包作为插件组合在 Cordis 应用中，依赖 `sessions`、`remote`、`uiSession`、`slots` 和 `locale` 服务。激活后，它通过 `ctx.remote.$on('approval/request')` 监听 Remote Event waterfall，并为每个待处理请求创建 `PendingApproval` 实例。

### 审批流程

当 Host 通过 Remote Event 发起 `approval/request` 时，本包：

1. 通过 `ctx.uiSession.registerPendingInteraction()` 注册待处理审批，使其出现在 `sessionPendingInteraction` 快照中。
2. 在 `conversation.composer` slot 中注入 `ApprovalPanel` 组件，接管编辑器区域。
3. 用户看到审批面板，展示工具名称、请求原因（如有）和关联的 Tool 详情（如有）。
4. 用户选择「允许一次」或「拒绝」，决定通过 `pending.answer()` 返回给 Host waterfall。

### 关联 Tool 详情

如果审批请求携带 `callId`，`conversation.approval.detail` slot 会渲染关联的 Tool 调用详情。其他插件可以通过注册该 slot 贡献自定义详情视图。

### 与 `PENDING_INTERACTION_PRECEDENCE` 的关系

`registerPendingInteraction` 的 precedence 函数返回 `0`，表示本包不试图抢占其他待处理交互（如用户提问面板）。当多个待处理交互同时存在时，优先级更高的交互胜出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 注册

浏览器插件入口（`src/client/index.ts`）注册 `approval` 命名空间的简体中文字典，然后在 `conversation.composer` slot 上注册 `ApprovalPanel` 组件。该 slot 的 `select` 函数通过 `pendingInteraction instanceof PendingApproval` 判别当前待处理交互是否为审批请求。

### Remote Event 监听

`ctx.remote.$on('approval/request')` 注册 waterfall 消费者。`answerApproval` 函数创建 `PendingApproval` 实例，注册待处理交互，等待用户决策，然后将结果返回给 Host。如果用户选择委托（delegate），则调用 `next()` 将请求传递给 waterfall 中的下一个消费者。

### PendingApproval 生命周期

`PendingApproval` 类（`src/client/contract/slots.ts`）封装了一个审批请求的完整生命周期：

- **key**: 不透明的渲染标识，每次审批请求唯一。
- **result**: 一个 Promise，在用户做出决定时解析为 `'allowed-once'` 或 `'rejected'`。
- **answer()**: 用户做出决定，解析 promise。
- **delegate()**: 将未回答的请求委托给下一个 waterfall 监听器。
- **abort()**: 当传输层、作用域或插件生命周期结束时终止请求。
- **signal**: 可选的 AbortSignal，Host 瀑布可通过它取消审批请求。

### 声明合并

本包通过 TypeScript 声明合并扩展了以下接口：
- `SessionPendingInteractionMap`：添加 `approval: PendingApproval` 条目。
- `LocaleNamespaceMap`：添加 `approval` 命名空间。
- `SlotMap`：添加 `conversation.approval.detail` 可选 slot。

### 不变式

运行时不维护不可变式：注册表和 owner 观察 Remote 监听器和临时 Slot 条目。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖审批流程的上下游与相关 seam。

- [ui-conversation](../ui-conversation/README.zh.md)——承载 `conversation.composer` slot 的对话界面。
- [ui-session](../ui-session/README.zh.md)——提供 `registerPendingInteraction` 和 `sessionPendingInteraction` 快照的 Session 适配器。
- [ui-slots](../ui-slots/README.zh.md)——slot 注册与组合系统。
- [ui-renderer](../ui-renderer/README.zh.md)——React 渲染器与 slot 绑定。
- [api-remotes](../../api/remotes/README.zh.md)——Remote Event 传输层，`approval/request` 的承载通道。
- [api-session-controller](../../api/session-controller/README.zh.md)——提供 Session 作用域与生命周期管理。
- [interaction](../../interaction/README.zh.md)——Host 侧审批能力 seam。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只在浏览器中呈现审批请求，不注册任何面向模型的内容。

#### KV Cache 影响

无；审批请求和响应的呈现不会改变模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **面板只提供临时决定**——它支持仅本次允许和拒绝；持久权限策略仍由 Host 侧审批 package 拥有。
- **无批量审批**——每个请求独立呈现，不支持一次性审批多个待处理请求。
- **详情 slot 依赖 Tool 调用窗口**——关联的 Tool 详情仅当 `callId` 存在且对应的 slot 已注册时才会渲染。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>