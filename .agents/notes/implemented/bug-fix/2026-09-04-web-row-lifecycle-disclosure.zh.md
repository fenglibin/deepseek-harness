# Agent Note: 工具行折叠行为收敛到一份生命周期契约

Status: implemented

[English](2026-09-04-web-row-lifecycle-disclosure.md) | 中文

## Problem

工具行本应在调用运行期间展开、在结算的瞬间折叠。只有一个组件实现了这一点：`packages/client/ui-tool` 里的 `ToolRow` 通过 `state === 'running'` 打开，并用 `useRef` + `useEffect` 的迁移守卫来折叠。`packages/client/ui-chat` 里的 `ReasoningRow` 手抄了一份副本。其他所有展示工具或命令结果的行都只持有一个裸的 `useState(false)`，既不在运行时展开，也不在结算时折叠。

后果有两处可见。`bash` 调用由 `BashRow` 渲染——它是取代 `ToolRow` 的 `tool.call.toolview` keyed 条目——因此它在命令运行期间从不展开，而读者一旦展开它（点击行，或点 `查看全部` 高度控件），它就会在本次会话余下的时间里一直开着。`cordis_define` 由 `CordisDefineRow` 渲染，它的源码标签来自调用参数，因此在运行期间本就可展开，却有着同样的缺口。`skill` 行与命令行事实上豁免：它们在结算前没有任何输出，因此没有可驱动的生命周期。

反向的缺陷更严重，因为它不可见。`AskQuestionRow` 以 `transcript !== null` 传入 `restingExpanded`（原先叫 `defaultExpanded`），而 transcript 只出现在结算结果里。`ToolRow` 只在 `useState` 的初始化器里读过这个标志一次，而它的结算 effect 无条件折叠——于是读者刚刚回答完的那一行，会在产出答案的同一次提交中被折叠起来。唯一点名了这个迁移的测试 `tool-row.client.spec.tsx` 先调 `cleanup()` 再渲染一个全新的结算态组件，因此它断言的是挂载默认值，从未真正走过 running → settled。

只有生命周期契约并不能关闭这份报告。折叠态的 `bash` 行仍然以两行 `peek` 阶段渲染它的终端卡片，于是"折叠"之后输出框依旧在屏——与读者报告的"从不折叠"逐像素相同。其他所有工具行在折叠时都会把输出整个移除；`bash` 是唯一保留预览的行，也正是报告人唯一能点名的行。结算折叠是真实的，但不可观测。

## Decision

`packages/client/ui-primitives/src/use-lifecycle-expansion.ts` 里的 `useLifecycleExpansion` 持有整份契约，所有具备该生命周期的行都使用它。它接受 `{ running, restingExpanded }`，在 `running` 为真时展开，并在 running → settled 迁移时折回**当前**的 `restingExpanded`，而不是 `false`。在 effect 运行时读取静止值——不是从 ref 读，也不只在 state 初始化器里读——正是让 ask-user 行能够穿过产出其 transcript 的那次结算而保持展开的原因。`useRef` 守卫让 effect 只作用于迁移本身，因此重新打开一个已结算的行仍能在此后的每次渲染中存活。

`ToolRow` 把 `defaultExpanded` prop 改名为 `restingExpanded`，因为旧名字描述的是一个"挂载期默认值"，而它已不再是。`BashRow`、`CordisDefineRow` 与 `ReasoningRow` 采用该 hook；`ReasoningRow` 通过包裹 hook 的 toggle 保留了它的跟随尾部滚动。`SkillRow` 与 `GenericCommandCard` 有意保留 `useState(false)`：两者的 `expandable` 都由其输出推导，而输出在调用结算前为 null，所以在那里放生命周期 hook 只会驱动读者观察不到的状态。

折叠态的 `bash` 行完全不渲染终端卡片。`OutputStage` 去掉了 `peek`，于是展开的行只有 `full`（十行）与 `all`（不受限）两态，卡片随 `open` 挂载与卸载，与 `ToolRow` 的正文一致；两行上限以及它所需的滚动条抑制规则随之离开 `bash-sample.module.css`。`查看全部` 控件保持不变，并且现在是从长命令触达任何输出的唯一途径：它仍然先把折叠行开到十行上限，再转为不受限。卡片的 `inspect` 按钮移入展开分支之内，与所有把控件门控在折叠之后的行保持一致。

## Alternatives considered

**给 `ToolRow` 加一个 effect，在 `defaultExpanded` 翻到 true 时重新展开。** 否决：这会让两个 effect 争夺同一个 state——折叠发生在同一次提交——而且它会让 `ReasoningRow` 与 `BashRow` 里的副本继续漂移。

**让每一行各自保留迁移守卫。** 否决：`ToolRow` 与 `ReasoningRow` 在命名与注释面上已经分化，而读者最常看到的两行（`bash`、`cordis_define`）根本没有；再抄第三、第四份只会拉大差距而不是弥合它。

**在每次非 running 的渲染上折叠。** 否决：读者重新打开一个已完成的行来复读时，会被下一次无关的渲染一把合上——这正是 `useRef` 守卫要防止的失败。

**为一致性也让 `SkillRow` 与 `GenericCommandCard` 采用该 hook。** 否决：规则要求有当前的 owner 与需求。两行在结算前都无法展开，因此 hook 在那里会变成不可观测的状态机制，而测试只能断言"没有差异"。

**给 `CordisRunRow` 与 `CordisActionRow` 加折叠。** 推迟：两者都把输出渲染为无条件的 `<pre>`、没有折叠形态，因此让它们折叠是新增交互面——点击目标、`aria-expanded` 契约，以及行 toggle 与既有 `inspect` 按钮之间的交互——而不是一次生命周期修复。`packages/extensions/ui-cordis` 没有承载它的组件测试通道。

**保留两行预览，让结算折叠到它。** 否决：那正是已上线的行为，也正是产生这份报告的原因。折完仍显示输出框，读起来就不算折叠。

**移除卡片，但在摘要行打印输出行数。** 否决：它要求读者去解读一个数字，而这一行打开就能回答；行数恰恰是打开这一动作本身能够直接回答的事实。摘要仍然是对命令的描述。

## Consequences

运行中的 `bash` 行现在会展开，这正是其他工具行早已具备的行为；结算时它的终端卡片被移出 DOM，而不是缩成预览。`查看全部` 控件仍然只在输出超过十行时出现，因此运行中的命令（尚无输出）不受它影响。`cordis_define` 在调用进行中展开。ask-user 行能穿过自身的结算而保持展开，这正是它的 `restingExpanded` 注释一直声称的行为。

这份契约的回归测试现在是真实的：`tool-row.client.spec.tsx` 用 rerender 让同一个组件走过 running → settled，并同时断言普通折叠与静止态展开两种情形；`use-lifecycle-expansion.client.spec.tsx` 直接钉住 hook 的五种迁移。三行共用一份实现，而不是一行为主、两行抄写。

`assembly-surfaces.client.spec.tsx` 通过真实事件流驱动一次 `bash` 调用与一次 `pwsh` 调用——先 `tool/call`，再向live会话追加 `tool/result`——并读取结算后的 DOM，而不是手工搭出的组件树：bash 行失去其终端卡片，通用行失去其输出文本。运行态自身的断言来自同一条路径，这正是先证明生命周期修复到达了浏览器、再证明预览是剩下问题的依据。

本 note 未改变的已知缺口：`CordisRunRow` 与 `CordisActionRow` 仍无条件展示输出，从不折叠。

## Related

[命令行文案契约](../architecture/2026-07-30-command-row-copy-contract.zh.md) 拥有"折叠态命令行说什么"，本 note 拥有"行是否处于折叠态"。二者在 `GenericCommandCard` 处交汇：它遵守文案规则，且自身没有生命周期。

[标准模式流内行折叠](../feature/2026-09-02-standard-mode-flow-row-disclosure.zh.md) 给了折叠态 bash 行那两行预览，并否决了"把终端门控在 `open` 之后"。本 note 反转了那一个决策，并保留该 note 的其余机制——`data-stage` 包装元素、由 `--dsl-terminal-line-height` 派生的十行上限、以及 `查看全部` 控件；它关于 `peek` 的描述记录的是该阶段上线时的形态，而非它现在的形态。
