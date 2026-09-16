# 技术决策

设计草案见 [docs/design/upstream-diff-analysis.zh.md](../../../docs/design/upstream-diff-analysis.zh.md) 第 3.1 节。本文件记录决策编号，供 tasks.md 锚定。

### D1 keyedHooks 是 hooks 的纯增量分支

`InjectFace` 的类型合成从两分支改为三分支：`hooks` 与 `keyedHooks` 都在、只有 `hooks`、只有 `keyedHooks`，其余原样透传。

`keyedHooks` 声明的每个源以 `use<Name>` 形式到达 props，类型为 `KeyedSnapshotSelectorHook<Snapshot>`——一个既可直接调用（返回当前值或 `undefined`）也可传入选择器与相等函数的双签名钩子。`hooks` 声明的源继续合成 `PropsHooks`，行为不变。

三分支的写法使既有消费方零改动：未声明 `keyedHooks` 的 inject 面落到原有的 `hooks` 分支或原样分支。

### D2 绑定在既有 cache 轴上完成

`scoped-slots.tsx` 的 `bindInjectHooks` 在 entry 级缓存轴上工作。本变更让它同时遍历 `hooks` 与 `keyedHooks`，对 keyed 源调用 `keyedObservableHook`。

`keyedObservableHook`（`bindings.tsx:104`）已存在并用 `WeakMap` 按源缓存生成的钩子，因此同一 keyed 源在多次绑定间复用同一个钩子实例，不产生新的订阅。

### D3 ResourceProtocolMap 是零依赖合并点

`ui-slots` 声明空的 `ResourceProtocolMap` 接口，各协议属主在自己的包里合并成员（如 `file`）。`useResource<P>(address)` 按 `P` 收窄其值的类型。

该声明放在 `ui-slots` 而不是 `resources` 包，使协议属主无需依赖资源实现包即可声明自己的成员。`ui-slots` 因此保持零运行时依赖。

### D4 资源记录的来源引用必须稳定

`ResourceRegistry` 的记录在最后一个持有者释放后仍保留，只把快照重置为空闲状态，不删除记录。

理由是 `source(address)` 的引用必须跨 React 的"先渲染后订阅"窗口与 StrictMode 的重挂载保持稳定。代价是内存随读过的不同地址数增长，官方 README 明确记录了该取舍。

### D5 持有者计数合并订阅与 pin

资源的持有者 = 正在订阅的 `useResource` 调用 + 显式 `pin`。第一个持有者开启提供方的异步流，最后一个释放时中止流并把快照重置为 `none`（无提供方）或 `loading`（有提供方）。

`pin(address, signal)` 不产生订阅，只在 `signal` 中止前让资源保持打开。典型用途是侧栏在标签页存续期内保持其地址的数据流。

### D6 host 半身是空实现

`packages/client/resources` 的 `src/index.ts` 只导出空的 `apply`，因为资源模型完全属于浏览器侧。

这与本地既有纯客户端包的惯例一致，同时让该包可以在 host 侧的 Cordis 树中被安全挂载。

### D7 本批次只落地基础设施

本地没有 `packages/api/workspace-files`、`packages/client/ui-sidebar-documentpreview` 与 `packages/client/ui-sidebar-right`，因此 `resources` 落地后没有任何 provider 与消费者。

本批次仍交付它，理由是：keyed hooks 的类型合成（D1、D2）有独立价值且风险低；`resources` 是后续侧栏批次的前置，先落地可以让后续批次专注在能力本身。该状态在包 README 的"已知限制与延期工作"中显式记录，避免读者误判它是死代码。

## 被拒绝的方案

**把 `ResourceProtocolMap` 放在 `resources` 包**：不采用。协议属主（如文件浏览器）需要声明自己的成员，若合并点位于资源实现包，属主就必须依赖该实现包，形成反向依赖。

**在释放全部持有者时删除资源记录**：不采用。记录删除会让 `source(address)` 返回新引用，破坏 React 渲染到订阅窗口与 StrictMode 重挂载期间的一致性。

**同时改名 `bindInjectHooks` 为 `bindInjectSources`**：不采用。改名会波及该文件的既有引用与测试，与本变更的功能目标无关；本地保留原名并在 JSDoc 中说明它同时处理两类源。

**把 keyedHooks 合成与资源包拆成两个变更**：不采用。两者共享同一份 `context.resources` 协议声明，拆开后类型合成的正确性缺少端到端证据。注意 `resources` 当前无 provider 也无消费者（见 D7），因此这里的理由只是「同一份类型契约不应分两次落地」，不是「已有真实消费方」。
