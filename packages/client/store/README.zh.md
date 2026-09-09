---
description: "具有显式快照、订阅与生命周期所有权的浏览器可观察状态 store。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-store

## 概述

`dsh-client-store` 是供 Client controller 与 renderer adapter 共用的不依赖 React 的 observable 和 snapshot-store 基础设施。本包负责同步与 animation-frame 发布、基于 Immer 的更新、浅比较和可选的浏览器持久化；React hook 的构造仍属于 `@deepseek-ai/dsh-client-ui-renderer`。当 Client 状态必须在不依赖 React 的情况下发布稳定 snapshot 时，请使用它。

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

本包是一个库而非插件，导出 store 引擎和类型契约供其他包消费。

### 创建快照 store

```typescript
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const store = createSnapshotStore({ count: 0, items: [] })
store.update(draft => { draft.count += 1 })
store.set({ count: 0, items: [] })
const snapshot = store.getSnapshot()
const unsubscribe = store.subscribe(() => { console.log('state changed') })
```

`createSnapshotStore` 支持两种 flush 模式：

- `sync`（默认）——同步通知，适用于受控输入等需要同 tick 回显的场景。
- `raf`——合并一帧内的多次更新为一次通知，适用于高频更新场景。

### 声明式 store 定义

```typescript
import { defineStore } from '@deepseek-ai/dsh-client-store'

const handle = defineStore({
  init: () => ({ count: 0 }),
  persist: 'my-store-key',
  actions: {
    increment: (draft, by: number) => { draft.count += by },
    reset: (draft) => { draft.count = 0 },
  },
})

// 创建实例（框架侧使用）
const instance = handle.create()
instance.actions.increment(5)
instance.actions.reset()
```

`defineStore` 返回一个 `EngineStoreHandle`，其 `create()` 方法生产引擎实例。实例的 `actions` 是剥离了 draft 参数的 baked callback。`persist` 键启用 `localStorage` 持久化，存储失败不会破坏 store。

### 辅助函数

- `notifySubscribers(listeners, label, ...args)`——安全地通知一组观察者，防止单个回调饿死其他回调。
- `shallowEqual(a, b)`——zustand/shallow 语义的浅比较函数。

### 类型契约

本包导出 `store/contract.ts` 中定义的全部类型契约，包括：

- `ObservableSnapshot<T>`——最小可观察快照源接口。
- `SnapshotSelectorHook<T>`——类型化 selector hook 签名。
- `StoreHandle<T, A>`——store handle，包含 spec 和 `create()` 工厂。
- `StoreInstance<T, A>`——store 实例，包含 actions、getSnapshot、subscribe 和 clearPersisted。
- `PropsStore<H>`——组件从 slot 系统接收的 store 相关 props 类型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 引擎架构

`createSnapshotStore` 基于 zustand 的 `createStore`，使用 `subscribeWithSelector` 中间件，并附加 Immer 的 `produce` 进行不可变更新。引擎通过 `notifySubscribers` 安全地分发通知，防止单个回调抛异常影响其他监听器。

### RAF 批处理

当 `flush` 设为 `'raf'` 时，`rafBatch` 函数使用 `requestAnimationFrame`（在 Node 环境中回退到 `queueMicrotask`）将一帧内的多次更新合并为一次通知。这保证了 `N 次更新 = 1 次通知` 的契约。

### 持久化

`attachPersistence` 函数将 store 状态持久化到 `localStorage`。它使用整值 JSON 持久化（而非 zustand 的 persist 中间件），以避免后者在原始值状态下的扩展 bug。非浏览器环境静默禁用持久化，不抛出错误。

### 声明式 store

`defineStore` 的 `actions` 位置通过 TypeScript 的类型推断实现：`T` 从 `init` 的返回值推断，然后每个 action 的 `draft` 参数被上下文类型化为 `T`。`create()` 方法为每个 action 绑定 store 实例，生成剥离 draft 参数的 baked callback。

### 不变式

运行时不维护不可变式：包导出库引擎，不创建进程全局状态；每个 store 实例由其 owner 的测试覆盖。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖 store 消费者的渲染适配和 slot 集成。

- [ui-renderer](../ui-renderer/README.zh.md)——将 store 的 observable snapshot 绑定为 React hook 的渲染器适配器。
- [ui-slots](../ui-slots/README.zh.md)——拥有 store 契约权威定义（`StoreHandle`、`StoreInstance`、`PropsStore`）的 slot 系统。
- [ui-session](../ui-session/README.zh.md)——使用 `notifySubscribers` 的 Session 状态适配器。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包提供浏览器侧状态基础设施，不注册任何面向模型的内容。

#### KV Cache 影响

无；这些 store 既不组装也不发送模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **持久化仅限浏览器本地**——持久化 store 使用 `localStorage` 中的 JSON；非浏览器运行时会禁用持久化，本包也不提供跨设备同步。
- **无跨实例去重**——`create()` 对相同 handle × scope key 不自动去重；多个实例共享同一 `localStorage` key 会互相污染。框架层负责实例唯一性，测试层使用不同 scope key 或免持久化声明。
- **无中间件链**——引擎不支持 zustand 的中间件链；需要自定义中间件行为时需直接使用 `createSnapshotStore` 而非 `defineStore`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>