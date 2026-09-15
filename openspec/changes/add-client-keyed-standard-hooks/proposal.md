# 补齐客户端 keyed 标准钩子的类型合成与绑定

## 为什么

本地渲染层的 keyed 标准源链路已经完整：`packages/client/ui-slots/src/renderer.ts:65` 定义 `KeyedStandardSource`，`:78` 的 `StandardSourceBinding` 携带 `keyedHooks`，`:111-114` 的 `RootStandardSourceContribution` 接受 `keyedHooks`；`packages/client/ui-renderer/src/client/registry.ts:275` 的 `provideRoot` 接收该贡献；`bindings.tsx:104` 的 `keyedObservableHook` 生成按 key 订阅的钩子；`scoped-slots.tsx:384-389` 的 `materializeStandardBinding` 已有 keyedHooks 分支。

缺口只在两处：

1. `packages/client/ui-slots/src/index.ts:447-448` 的 `InjectFace` 只有两个分支（`hooks` 存在与否），**没有 keyedHooks 的类型合成**，因此 `keyedHooks` 声明的源无法以 `use<Name>(key)` 形式到达组件 props
2. `packages/client/ui-renderer/src/client/scoped-slots.tsx:116-130` 的 `bindInjectHooks` 只遍历 `hooks`，**不处理 entry 级的 `keyedHooks`**

官方用 `KeyedHooksSources`、`KeyedSnapshotSelectorHook`、`PropsKeyedHooks` 与 `bindInjectSources` 补齐这两处（`ui-slots/src/index.ts:387-471`、`scoped-slots.tsx:115-135`）。这是官方后续所有按 key 细粒度订阅（含渲染粒度优化）的类型基础。

## 做什么

- 在 `ui-slots` 新增 `KeyedHooksSources`、`KeyedSnapshotSelectorHook<Snapshot>`、`PropsKeyedHooks<HS>`，并把 `InjectFace` 改为三分支
- 在 `ui-slots` 新增空的 `ResourceProtocolMap` 接口作为协议合并点
- 把 `scoped-slots.tsx` 的 `bindInjectHooks` 扩展为同时绑定 `hooks` 与 `keyedHooks`
- 新增 `packages/client/resources` 包，提供 `ctx.resources` 与全局 `useResource` 钩子

## 不做什么

- 不改 `hooks` 既有契约：`PropsHooks` 与 `observableHook` 路径保持原样，`keyedHooks` 是纯增量分支
- 不移植官方删除详情面板的改动：`ui-chat/DetailsPanel`、`ui-tool/ToolDetails` 与相关 slot 的移除依赖右侧栏体系，本地不具备
- 不为 `resources` 包补 provider 与消费者：本地的 `workspace-files`、`ui-sidebar-documentpreview`、`ui-sidebar-right` 均不存在，该包在本批次落地后是基础设施，消费者在后续批次接入
- 不改 `KeyedSnapshotHook`（`bindings.tsx` 已导出的非泛型版本）：两者命名相近但分属渲染层与类型层，共存的现状不引入歧义

## 影响

- `packages/client/ui-slots/src/index.ts`：新增三个类型与 `ResourceProtocolMap`，`InjectFace` 改为三分支
- `packages/client/ui-renderer/src/client/scoped-slots.tsx`：`bindInjectHooks` 增加 keyedHooks 循环（官方改名为 `bindInjectSources`）
- `packages/client/resources/`：新增包（host 半身是空实现，浏览器半身含资源注册表）
- `packages/bundle/web-app`、`tsconfig.base.json`、`tsconfig.client.json`：登记新包

`InjectFace` 被所有 slot 组件消费，改动是纯扩展但影响面广；`resources` 引入新的 `ctx` 服务与全局标准 prop，定为 l2。
