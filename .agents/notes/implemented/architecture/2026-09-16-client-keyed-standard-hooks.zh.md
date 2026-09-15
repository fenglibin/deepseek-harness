# Agent Note: 客户端 keyed 标准源的 inject 类型合成与资源模型

Status: implemented

## Problem

客户端渲染层的 keyed 标准源链路本来就已经完整：`KeyedStandardSource`、`StandardSourceBinding.keyedHooks` 与 `RootStandardSourceContribution.keyedHooks` 都已存在，渲染器也会把根级贡献的 keyed 源绑定为按 key 订阅的钩子。缺的只有两端——`InjectFace` 只有 `hooks` 与非 `hooks` 两个分支，`entry` 级 inject face 上声明的 `keyedHooks` 无法以 `use<Name>(key)` 形式到达组件 props；`bindInjectHooks` 也只遍历 `hooks`。没有这两处，按 key 细粒度订阅无法从插件侧声明。

同时，客户端缺少一个统一的资源模型：组件常常只知道数据的 URL 地址（标签记录、链接、提及），而数据由另一个客户端包拥有。没有这层模型时，每个消费方都会自己接线订阅、自己决定生命周期，也就无法共享同一地址的数据流。

## Decision

`InjectFace` 改为三分支：`hooks` 与 `keyedHooks` 都在、只有 `hooks`、只有 `keyedHooks`，其余原样透传。`keyedHooks` 的每个源合成为 `use<Name>`，类型是双签名的 `KeyedSnapshotSelectorHook<Snapshot>`——既可直接以 key 调用并返回当前值或 `undefined`，也可传入选择器与可选相等函数。未声明 `keyedHooks` 的面合成结果与本次变更前完全一致，因此既有消费方零改动。

`bindInjectHooks` 在同一 entry 级 cache 轴上同时遍历两个分区，对 keyed 源调用既有的 `keyedObservableHook`（它已按源以 `WeakMap` 缓存钩子实例）。本地保留原名而不改名为官方的 `bindInjectSources`，并在 JSDoc 中说明它同时处理两类源。

`ResourceProtocolMap` 声明在 `ui-slots` 而不是资源实现包：协议属主需要声明自己的成员，若合并点位于实现包，属主就必须依赖该实现包，形成反向依赖。`ui-slots` 因此保持零运行时依赖。

新增的 `packages/client/resources` 提供 `ctx.resources` 与全局 `useResource` 钩子：地址采用 `dsh-resource://<protocol>/…`，host 部分即协议名；协议属主注册一个提供方，把地址变为帧流。`ResourceRegistry` 的记录在最后一个持有者释放后**仍然保留**，只把快照重置为空闲状态，不删除记录。持有者是订阅中的 `useResource` 调用加显式 `pin`；第一个持有者开启提供方的流，最后一个释放时中止流。

host 半身只导出空的 `apply`，因为资源模型完全属于浏览器侧。

## Alternatives considered

**把 `ResourceProtocolMap` 放在 `resources` 包**：不采用，理由如上（反向依赖）。

**在释放全部持有者时删除资源记录**：不采用。记录删除会让 `source(address)` 返回新引用，破坏 React「先渲染后订阅」窗口与 StrictMode 重挂载期间的一致性；代价是内存随读过的不同地址数增长，包 README 显式记录了该取舍。

**把 `bindInjectHooks` 同时改名为 `bindInjectSources`**：不采用。改名会波及该文件的既有引用与测试，与本变更的功能目标无关。

**把 keyedHooks 合成与资源包拆成两个变更**：不采用。`resources` 是 keyed hooks 的第一个真实消费者，拆开后类型合成的正确性缺少端到端证据。

## Consequences

`InjectFace` 被所有 slot 组件消费，因此这次改动虽然只是纯扩展，影响面却很广：它让 `GlobalStandardProps` 上出现了一个新的必填成员 `useResource`，所有手工构造组件 props 的测试 fixture 都必须补上它。这是设计使然——标准 props 是组件的唯一数据入口，可选的必有来源。

`packages/client/resources` 落地后在本仓库**暂无 provider 与消费者**：本地缺少 `api/workspace-files`、`ui-sidebar-documentpreview` 与 `ui-sidebar-right`。本批次仍交付它，理由是 keyed hooks 的类型合成有独立价值且风险低，而 `resources` 是后续侧栏批次的前置；该状态在包 README 的「已知限制与延期工作」中显式记录，避免读者误判它是死代码。

`resources` 引入了一个新的 `ctx` 服务与一个全局标准 prop，因此定为 l2 变更。

## Testing

`packages/client/resources/tests/resources.client.spec.ts` 覆盖协议解析（含非法地址与空 host）、重复注册被拒、注册随作用域撤销、四种 status 转换、失败帧保留上一个值、持有者计数、`pin` 不产生订阅、迟到帧丢弃与 `source()` 引用稳定。

`packages/client/resources/tests/apply.client.spec.ts` 断言服务面提供与释放、根级 keyed 源贡献的注册与撤回，以及 Root 与 Session 组件共享同一地址且切换选中时不重新开流。

`packages/client/ui-slots/tests/type-chain.client.spec.tsx` 以编译期样本固定三分支：两个分区都在、只有 `hooks`、两者都不声明。

`packages/client/ui-renderer/tests/scoped-slots.client.spec.tsx` 覆盖 keyed 分区的实际绑定：原始分区不到达组件、按 key 的选择器只在该 key 变化时重渲染、未声明分区的面原样透传。

## Related

- [Web 客户端架构](2026-07-19-gui-web-client-architecture.zh.md)——slot 系统接入的加载链与对象层。
- [slot 系统标准](2026-07-22-slot-type-chain-implementation.zh.md)——四 share 组合模型。
