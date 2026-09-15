---
description: "客户端资源模型：按协议注册的提供方把 URL 地址解析为实时值，任何 slot 组件都通过 useResource 标准钩子读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-resources

## 概述

当组件只知道实时数据的 URL 地址，而数据由另一个客户端包拥有时，请使用客户端资源；例如 tab 记录、链接或提及。资源地址使用 `dsh-resource://<type>/…`；需要作用域的协议把作用域编进路径。组件通过公开的 `useResource` 钩子接收当前值与后续更新。不支持的协议与非资源 scheme（例如 `sidebar://guide`）不指向任何资源。

## 目录

- [使用本包](#use-this-package)
  - [读取资源](#read-a-resource)
  - [提供协议](#provide-a-protocol)
  - [钉住资源](#hold-a-resource-open)
- [理解实现](#understand-the-implementation)
  - [生命周期](#lifecycle)
  - [失败](#failures)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载无需任何配置：插件提供 `ctx.resources`，并通过 `ctx.slots.provideRoot` 贡献 `resource` 根级 keyed 钩子，因此每个 slot 组件不论作用域都能收到它。

<a id="read-a-resource"></a>
### 读取资源

每个 slot 组件都在 props 上收到 `useResource`。`useResource<P>(address)` 以类型参数命名协议，返回 `{ status, value, failure }`：地址协议没有提供方（或地址不是 `dsh-resource://` URL）时为 `none`，提供方已打开但尚未产出时为 `loading`，`live` 携带最新一个 `ok` 帧的值，`failed` 表示最新一帧报告了失败，失败放在最后一个值旁。通过钩子订阅就是持有资源的方式；另一个持有者让资源保持存活时，新挂载的组件立刻读到最新值。

<a id="provide-a-protocol"></a>
### 提供协议

协议所属的客户端包在 `ResourceProtocolMap` 声明其值类型，并以自有 effect 注册一个提供方。`open` 产出 `RemoteResult` 帧：先是当前内容，之后每次变化一帧，失败以 `ok: false` 帧而非抛错表达；必须在 `signal` 中止时停止：

```ts ignore-check
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { note: NoteView }
}

export const inject = ['resources']

export function apply(ctx) {
  ctx.effect(() => ctx.resources.register<'note'>({
    protocol: 'note',
    async *open(address, { signal }) {
      yield await readNote(address, signal)
      for await (const change of followNote(address, signal)) yield change
    },
  }), 'my-notes: note resource provider')
}
```

一个协议恰有一个提供方；第二次注册会抛错。提供方注册时若其协议的地址已被持有，则立即开流；提供方被释放时结束这些流并让它们回到 `none`。

<a id="hold-a-resource-open"></a>
### 钉住资源

`ctx.resources.pin(address, signal)` 在不订阅的情况下让资源保持打开，直到 `signal` 中止。需要「标签页存续期内保持其数据流」的界面在标签记录的存续期内钉住该地址，因此卸载正文不会关闭其流，重新挂载时读到最新值。`ctx.resources.source(address)` 是钩子背后的裸 observable，供 React 之外的调用方使用。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

<a id="lifecycle"></a>
### 生命周期

每个地址一条记录，持有一个快照存储、一个持有者计数（钩子订阅者加 pin）与运行中流的 `AbortController`。第一个持有者打开提供方的流；之后的持有者共享它；最后一个持有者释放时中止流并把快照重置为空闲（有提供方为 `loading`，没有为 `none`）。记录在页面存续期内保留，使 `source()` 在 React 从渲染到订阅的窗口期以及 StrictMode 重挂载期间保持引用稳定。

<a id="failures"></a>
### 失败

失败是帧而非抛错：提供方产出 `{ ok: false, error }`，资源变为 `failed` 并把该错误放在最后一个值旁；下一个 `ok` 帧将其清除。自行结束的流保持其最后状态。在中止流的那次释放之后到达的帧都被丢弃，并归还迭代器。提供方流内的抛错是编程错误，不会被捕获。

</details>

<a id="model-experience"></a>
## 模型体验

无，因为本包在浏览器插件之间搬运值，不注册任何面向模型的内容。

#### KV Cache 影响

无；资源流不会组装模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **本批次落地后暂无协议属主与消费者**：本地缺少工作区文件（`api/workspace-files`）与右侧栏文档预览（`ui-sidebar-documentpreview`、`ui-sidebar-right`）等消费方，因此当前组合中没有任何协议被注册。本包是这些批次的前置基础设施，keyed 钩子的类型合成（`keyedHooks` → `useResource`）已有独立价值与端到端测试；消费者在后续侧栏批次接入。
- **记录在页面存续期内保留**——地址的记录在最后一个持有者离开后仍留在注册表中，只丢弃其状态。内存随读取过的不同地址数增长，而非随读取次数增长。
- **中止合规由提供方负责**——注册表会丢弃已释放的流仍产出的帧，但忽略 `signal` 的提供方会一直工作到它的下一帧。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布运行时检查。提供方归属与持有者计数只有注册表这一个拥有者，没有可供比对的独立运行时来源；注册的 dispose 与开流/停流生命周期由行为测试断言。
