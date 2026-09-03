# Agent Note: Slot abdication is scoped to the Session that crashed

Status: implemented

[English](2026-09-02-scoped-slot-abdication.md) | 中文

## Problem

`conversation.composer.bar` 是每页只注册一次的 `single`、`session-maybe` slot，因此每个 Session 渲染的都是同一个注册项。该 entry 内部的一次崩溃（组件渲染或 inject 工厂）会让它在注册存续期内彻底退休：`SlotCore` 用一个 `WeakSet` 保存已 abdicate 的 entry，并永久把它们排除在 `entriesOfSlot` 之外，唯一的恢复方式是刷新页面。用户可见的结果是：composer 同时在所有 Session 中消失，只有刷新后才回来；已输入的草稿不丢，因为它存放在逐 Session 的持久化 store 中。

有两条瞬时路径会触发这次崩溃。entry 的 inject 通过 `inputHub.shell(id)` 解析 Session 的 input shell，只要 binding 暂时不可解析，它就会抛出 `conversation.input: session "<id>" resolved no binding`——新建 Session 仍在激活、或切换中的 Session 正在重建 scope 的窗口正是如此。另一条是：composer 的 contenteditable 可能把 root element 绑定给一个 Session scope 已经销毁的 shell。

崩溃占位让这两条路径都变得无声：空的 `<div data-slot-error="…">` 与"没人填这个 slot"无法区分。

## Decision

Abdication 按 scope 生效。`SlotCore` 记录每次崩溃让 entry 退休时所处的 scope（用 `WeakMap<StoredEntry, string>` 取代 `WeakSet`）；`entriesOfSlot(key, scope)` 只在渲染该 scope 时跳过该 entry；`reportEntryError` 在 `info` 中携带 scope。root scope 的渲染退休在 `ABDICATION_SCOPE_ROOT` 下；Session 的渲染退休在 `abdicationScopeOf(binding.key)` 下，于是下一个 Session 会重新渲染该 entry。从崩溃的 Session 切走再切回时该退休仍然保留，因此一个 composer 确实损坏的 Session 不会陷入崩溃循环。

renderer 从 slot 声明的 scope 与正在渲染的 binding 推导 scope——声明为 `root` 的 slot 即使渲染在 Session 子树内，也退休在 root scope——并把它同时传给投影与崩溃上报。

崩溃占位是 `SlotCrashFace`，由 entry boundary 与干涸 cell 的投影共用。official 构建保留纯粹的 `[data-slot-error]` 标记元素；本地构建（`DSH_CLIENT_BUILD_PROFILE` 不是 `official` 时）把它渲染成带 slot key 的可见占位，slot key 是代码 token，因此既不引入产品文案，也能让开发期直接看到树上的空洞。

composer chrome 不再向两条路径提供燃料。`InputHub.tryShell(id)` 在 Session binding 不可解析时返回 `undefined`，而 `shell(id)`（调用方持有可寻址 Session 的编程式路径）仍然抛出。composer bar 的 inject 退化为它原本用于无 Session 的 inert 表面，scope 重建后 inject 会在新的 binding 上重新执行。`SessionInputShell` 公开 `live`，在 `dispose()` 之后为 false；`InputBar` 不再把已销毁 shell 的 editor 交出去：`editor: null` 到达 `ComposerContentEditable`，而后者本就把该状态渲染为 inert 且不绑定 root element。

## Alternatives considered

**改为每次重渲染都重试，而不是按 Session 重试。** 只要 outlet 重新投影就清除退休，会让一个确实损坏的 entry 在每次无关重渲染时重试，并产生崩溃日志循环。按 scope 记账则是每次 Session 变化重试一次。

**保留全局退休，由注册项选择退出。** 每个 slot 加一个开关会把框架不变量推给每个注册方，而最需要它的注册方恰恰是无法知道自己崩溃了的那个。

**在 official 构建中也展示崩溃占位。** 可见占位需要本地化文案；本地构建开关既保留了诊断能力，又不会把未翻译文本或框架装饰推给生产用户。

**在 inject 处返回一个空操作 shell，而不是降级。** 替身 shell 必须伪造 editor、submit 与 notice 通道；bar 已有的 inert 表面既存在，也诚实地表达了"没有输入"。

## Consequences

过去一次崩溃会让 composer 在所有 Session 中失效到刷新，现在只影响一个 Session，直到下一次切换；本地构建中崩溃占位还会点名失败的 slot。在 root scope 崩溃的注册项仍然保持退休直到注册被销毁——这一点未变，也是正确的，因为没有更窄的 scope 可以重试它。

composer 现在可能因为某个 Session 的 input shell 不可达而呈现 inert，这是一个可见状态，而此前它是整体消失；该状态在 scope 重建后结束。`ComposerKeyboard` 新增了 `live`，这是 package 内部契约，不会跨越插件边界。

## Testing

`packages/client/ui-slots/tests/core.client.spec.ts` 固定存储语义：只在被上报的 scope 内退休、chain entry 永不退休、省略 scope 时退休在 root 下。`packages/client/ui-renderer/tests/scoped-slots.client.spec.tsx` 让一个 `session-maybe` entry 在某个 Session 下崩溃，断言下一个 Session 会重新渲染它，并断言被上报与被用于投影的 scope；另一个用例固定两种构建形态下的崩溃占位。`packages/client/ui-conversation/tests/apply-inject.client.spec.tsx` 断言 ghost Session 的 inject 退化为 inert 表面，`tests/input-bar.client.spec.tsx` 断言已销毁的 shell 会让 composer 变为 inert。
