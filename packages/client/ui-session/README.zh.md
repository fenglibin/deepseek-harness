---
description: "面向 Session Controller 列表、交互状态与逐会话上下文的 React 与 Slot 适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session

## 概述

`dsh-client-ui-session` 是面向 Session Controller 状态的 React 与 Slot adapter。本包在 root scope 提供 Session list 和 pending-interaction hook，物化逐 Session hook 与 prop，并拥有标准 `SessionProvider` 渲染行为，但不接管 Session transport 或 lifecycle 状态。当浏览器功能需要通过标准 React prop 和 hook 读取 Session 状态时，请使用它。

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

本包注册为 Cordis 服务 `ctx.uiSession`（`UiSession` 类），依赖 `sessions` 和 `slots` 服务。它将 Session Controller 的原始状态适配为 slot 系统可消费的标准 source 和 adapter。

### 标准 Props

安装后，本包向 slot 系统贡献以下标准 props：

**Root scope：**
- `useSessions`——Session 列表和当前选择的 selector hook（`SnapshotSelectorHook<SessionListState>`）。
- `useSessionPendingInteraction`——按 Session 分组的待处理交互快照的 selector hook（`SnapshotSelectorHook<SessionPendingInteractionSnapshot>`）。

**Session scope：**
- `useSession`——当前 Session 生命周期和控制状态的 selector hook（`SessionSnapshotSelector`）。
- `sessionId`——当前 Session 的标识符。
- `useProjection`——Host 按投影键计算的投影值。

**Session-maybe scope（无 Session 时）：**
- `useSession`——可能为 `undefined` 的 Session 状态 selector。
- `sessionId`——可能为 `undefined` 的 Session 标识符。
- `useProjection`——每个键在无 Session 时都为 `undefined`。

### 注册 Session 层 source 贡献

其他插件可以通过 `ctx.uiSession.provide(descriptor)` 注册自己的 Session 层 source 贡献。descriptor 声明 hook、keyed hook 和 prop 的静态名册，以及为每个 Session binding 解析它们的 `resolve` 函数。

### 发布待处理交互

插件通过 `ctx.uiSession.registerPendingInteraction(precedence)` 注册自己的待处理交互域，获得一个 `PendingInteractionPublisher` 函数。该函数接受一个 `SessionPendingInteractionBase` 实例和一个委托函数，返回一个 dispose 函数。域卸载时，所有待处理交互会被委托并等待完成。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### UiSession 服务

`UiSession` 类（`src/client/index.ts`）是 Cordis Service，在构造函数中：

1. 设置内置 source 描述符（`BUILTIN_SOURCE`），提供 `session` hook、`projection` keyed hook 和 `sessionId` prop。
2. 订阅 Session 列表变化，并在变化时刷新当前 binding。
3. 创建 `adapter` 对象，注册为 `session` scope 的 SlotScopeAdapter。

### 当前 binding 管理

`UiSession` 维护一个 `currentBinding`，反映当前选中的 Session。当 Session 列表变化时，`publishCurrent()` 计算新的 binding 并通过 `notifySubscribers` 通知监听器。无 Session 时使用 `materializeAbsent()` 生成的缺席 binding，其中所有 hook 和 prop 均为 `undefined`。

### Session binding 物化

`materialize()` 方法遍历所有注册的描述符，为每个描述符调用 `resolve(binding)`，然后将结果合并到一个 `ScopedStandardSourceBinding` 中。`validateContribution` 确保每个贡献只声明了描述符名册中列出的成员。

### 待处理交互域

`PendingInteractionDomain` 类管理一个域内的所有待处理交互。它支持：

- 按 key 去重（重复 key 抛出错误）。
- 按 precedence 排序（跨域比较，precedence 更高的交互胜出）。
- 域卸载时释放所有交互并委托给对应的 owner。

### 快照相等性

`samePendingInteractions` 函数通过引用比较确定两个快照是否相等，避免不必要的通知。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖 Session 系统和 slot 渲染机制。

- [api-session-controller](../../api/session-controller/README.zh.md)——提供 Session Controller 原始状态和事件。
- [ui-slots](../ui-slots/README.zh.md)——slot 注册与组合系统，本包贡献的标准 props 在此消费。
- [ui-renderer](../ui-renderer/README.zh.md)——React 渲染器，将标准 source 绑定为组件 hook。
- [store](../store/README.zh.md)——提供 `notifySubscribers` 等基础设施。
- [ui-approval](../ui-approval/README.zh.md)——使用 `registerPendingInteraction` 的消费方示例。
- [ui-user-questions](../ui-user-questions/README.zh.md)——另一使用 `registerPendingInteraction` 的消费方示例。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包适配浏览器侧 Session 状态，不注册任何面向模型的内容。

#### KV Cache 影响

无；Session selector 与 Slot scope 不会组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **Pending interaction 是进程本地投影**——浏览器重连后，所属 Remote waterfall 必须重放仍未完成的请求。
- **无跨设备 Session 同步**——Session 列表和状态是进程本地的，不提供跨浏览器标签页或设备的同步。
- **描述符贡献不可动态移除**——`provide()` 返回 disposer，但移除后重新绑定所有 Session 可能产生短暂的中断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>