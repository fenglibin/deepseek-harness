# 实施清单

## 1. ui-slots 类型合成

- [x] 1.1 在 `packages/client/ui-slots/src/index.ts` 新增空的 `ResourceProtocolMap` 接口作为协议合并点，含说明它是零依赖合并点的 JSDoc (covers: client-keyed-hooks/客户端资源以地址寻址, design/D3)
- [x] 1.2 在同一文件新增 `KeyedHooksSources`（`Record<string, KeyedStandardSource>`）与 `KeyedSnapshotSelectorHook<Snapshot>`（双签名：直接调用返回当前值或 `undefined`，或传选择器与相等函数返回所选值） (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, client-keyed-hooks/按 key 的选择器收窄重渲染, design/D1)
- [x] 1.3 新增 `PropsKeyedHooks<HS>`：把每个 keyed 源映射为 `use<Name>` 形式的 `KeyedSnapshotSelectorHook`，快照类型从源函数推导 (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, design/D1)
- [x] 1.4 把 `InjectFace` 从两分支改为三分支：`hooks` 与 `keyedHooks` 都在、只有 `hooks`、只有 `keyedHooks`，其余原样透传 (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, client-keyed-hooks/未声明 keyedHooks 的面保持不变, design/D1)

## 2. 绑定层

- [x] 2.1 扩展 `packages/client/ui-renderer/src/client/scoped-slots.tsx` 的 `bindInjectHooks`：同时遍历 `hooks` 与 `keyedHooks`，对 keyed 源调用 `keyedObservableHook` (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, design/D2)
- [x] 2.2 更新该函数的 JSDoc，说明它同时处理两类源（本地保留函数原名，不改名为官方 `bindInjectSources`） (covers: client-keyed-hooks/未声明 keyedHooks 的面保持不变, design/D2)
- [x] 2.3 确认 `keyedObservableHook`（`packages/client/ui-renderer/src/client/bindings.tsx:104`）按源缓存钩子实例，使同一 keyed 源在多次绑定间复用 (covers: client-keyed-hooks/按 key 的选择器收窄重渲染, design/D2)

## 3. resources 包

- [x] 3.1 新建 `packages/client/resources/`，含 `package.json`（`dsh.client.platform` 为 `web`）、`tsconfig.json`、`tsdown.config.ts`、`src/css-modules.d.ts`（如需要） (covers: client-keyed-hooks/客户端资源以地址寻址, design/D6)
- [x] 3.2 编写 host 半身 `src/index.ts`：只导出空的 `apply`，使该包可在 host 侧 Cordis 树中安全挂载 (covers: client-keyed-hooks/客户端资源以地址寻址, design/D6)
- [x] 3.3 编写 `src/client/contract.ts`：声明 `GlobalStandardProps.useResource`、`Context.resources`、`ResourceProtocol`、`ResourceStatus`、`ResourceSnapshot<Value>`、`UseResource`、`ResourceOpenContext`、`ResourceProvider<P>` 与 `Resources` 接口 (covers: client-keyed-hooks/客户端资源以地址寻址, client-keyed-hooks/资源快照有四种状态, design/D3)
- [x] 3.4 编写 `src/client/resources.ts` 的 `ResourceRegistry`：`protocolOf(address)` 用 `new URL()` 解析并返回小写 host；`register` 拒绝重复协议并随作用域释放撤销；`pin(address, signal)` 在 signal 中止时释放；`source(address)` 返回按地址稳定的 observable (covers: client-keyed-hooks/注册协议提供方, client-keyed-hooks/重复注册同一协议被拒绝, client-keyed-hooks/非资源地址不解析协议, client-keyed-hooks/pin 不产生订阅但保持资源打开, client-keyed-hooks/pin 的 signal 中止时释放, client-keyed-hooks/来源引用跨重挂载保持稳定, design/D4, design/D5)
- [x] 3.5 实现持有者计数与流生命周期：第一个持有者开启提供方的异步流，最后一个释放时中止流并重置快照；失败帧保留上一个值 (covers: client-keyed-hooks/最后一个持有者释放时中止流, client-keyed-hooks/收到成功帧后为 live, client-keyed-hooks/失败帧保留上一个值, client-keyed-hooks/有提供方但未产出首帧时为 loading, client-keyed-hooks/无提供方时为 none, design/D4, design/D5)
- [x] 3.6 编写 `src/client/index.ts`：`inject = ['slots']`，构造注册表并 `ctx.reflect.provide('resources', …)`，经 `ctx.slots.provideRoot({ keyedHooks: { resource: address => resources.source(address) } })` 贡献根级 keyed 源 (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, design/D5)
- [x] 3.7 补 `src/invariant.ts` 伴生入口，按本地规则说明该包不发布运行时检查的理由 (covers: client-keyed-hooks/客户端资源以地址寻址)

## 4. 装配

- [x] 4.1 在 `packages/bundle/web-app/cordis.patch.yml` 挂载 `@deepseek-ai/dsh-client-resources`，并在其 `package.json` 添加依赖 (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, design/D7)
- [x] 4.2 在 `tsconfig.base.json` 的 paths（含 `/client` 子路径）与 `tsconfig.client.json` 的 references 中登记新包 (covers: client-keyed-hooks/客户端资源以地址寻址)

## 5. 测试

- [x] 5.1 新增 `packages/client/resources/tests/resources.client.spec.ts`：覆盖协议解析（含非法地址与空 host）、重复注册被拒、注册随作用域撤销、四种 status 转换、失败帧保留上一个值 (covers: client-keyed-hooks/注册协议提供方, client-keyed-hooks/重复注册同一协议被拒绝, client-keyed-hooks/非资源地址不解析协议, client-keyed-hooks/资源快照有四种状态, design/D3)
- [x] 5.2 在同一 spec 覆盖持有者计数：第一个持有者开流、最后一个释放中止流并重置快照、pin 不增加订阅、pin 的 signal 中止释放、`source()` 引用跨释放保持稳定 (covers: client-keyed-hooks/最后一个持有者释放时中止流, client-keyed-hooks/pin 不产生订阅但保持资源打开, client-keyed-hooks/pin 的 signal 中止时释放, client-keyed-hooks/来源引用跨重挂载保持稳定, design/D4, design/D5)
- [x] 5.3 新增 `packages/client/resources/tests/apply.client.spec.ts`：断言服务面提供与释放、根级 keyed 源贡献的注册与撤回 (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, design/D5)
- [x] 5.4 在 `packages/client/ui-slots` 与 `packages/client/ui-renderer` 补充类型级与绑定级用例：声明 `keyedHooks` 的面产出 `use<Name>`、未声明的面合成结果不变、按 key 选择器只在该 key 变化时重渲染 (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, client-keyed-hooks/未声明 keyedHooks 的面保持不变, client-keyed-hooks/按 key 的选择器收窄重渲染, design/D1, design/D2)
- [x] 5.5 运行 `packages/client/ui-slots` 与 `packages/client/ui-renderer` 的完整测试，确认 `InjectFace` 三分支改动对既有 slot 组件零回归 (covers: client-keyed-hooks/未声明 keyedHooks 的面保持不变, design/D1)

## 6. 文档

- [x] 6.1 编写 `packages/client/resources/README.zh.md`：地址协议、提供方注册、四种状态语义、持有与释放、`source()` 的引用稳定取舍，以及"已知限制与延期工作"中显式记录**本批次落地后暂无 provider 与消费者**，消费者在后续侧栏批次接入 (covers: design/D4, design/D5, design/D7)
- [x] 6.2 更新 `packages/client/ui-slots/README.zh.md`，记录 `keyedHooks` 的类型合成契约 (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, design/D1)
- [x] 6.3 更新 `packages/client/ui-renderer/README.zh.md`，说明绑定层同时处理 `hooks` 与 `keyedHooks` (covers: client-keyed-hooks/keyed 标准源合成为按 key 的选择器钩子, design/D2)
- [x] 6.4 新增 Agent Note 记录 keyed 标准源的类型合成契约与资源记录不删除的取舍 (covers: design/D1, design/D4)
