# Agent Note: 会话流程行标注文件操作、流式呈现思考、并为命令输出设限

Status: implemented

## Problem

Chat 视图——即 `packages/client/ui-chat/src/client/apply.ts` 以 `id: 'chat'`、`order: 0` 注册的 `conversation.view` 条目，产品称之为标准模式——把四件行内本已知晓的事情留给了读者去推断。

文件变更行会打印路径与 `+n -n` 统计，却从不说明**它对这个文件做了什么**。`ToolRow` 的标题仅由工具变体推导，于是「创建文件的 `write`」与「改写文件的 `edit`」在展开之前读来完全一样：唯一的区别是 diff 的首个 hunk 是否带有前一版本，而这一点没有任何地方呈现出来。

要看到 diff，得先找到 chevron。`DisclosureRow` 早已让整行成为切换区，但一个 chevron 只说明「这里还有东西」，并未说明是**什么**，于是这一行无法回答「它改的是不是我以为的那处」。

思考块比沉默更糟：它默认是**折叠**的，只显示一行——流式时显示最新一行，结束后显示第一行。想看模型如何思考的读者必须先点击，而流式摘要不过是一行横向滚动的省略号文本，并不是思考本身。

Bash 行则处在另一个极端。折叠时除摘要外什么都不显示；展开后以 `maxLines={Infinity}` 渲染终端卡片且没有高度上限，于是一条打印两百行的命令会在流式输出过程中把回复——以及其下每一行——挤出视口。

## Decision

**文件变更行在路径旁标出操作类型。** `diff-card-model.ts` 新增 `FileOperation`（`added` | `modified` | `deleted`）与 `fileOperation(toolName, diffs)`，从该行**实际呈现**的 hunk 推导：某个 hunk 的 `oldText` 为 null 意味着此文件此前没有版本，因此凡带前一版本的 hunk 即为修改，不带者即为创建。`DiffCardModel` 以 `operation` 承载结果，`ToolRow` 通过 `OPERATION_KEYS` 渲染——这是一个 `satisfies Record<FileOperation, LocaleKeysOf<'conversation'>>` 映射，因此缺词条是编译错误而非空白。

`deleted` 是预留而非可达：`intendedDiff` 对一切非变更类工具的 wire 名都返回 null，因此 `diffCardModel` 不会为删除工具产出卡片——也就不会产出 operation。词典仍保留该标签，这让接入删除工具成为修改该模块中 `intendedDiff` 的事，而非修改行组件。本 Note 早前的草稿声称行组件无需改动，那是错的；分类函数中也不保留任何实时路径永远走不到的删除分支。

**行内写明 chevron 所执行的动作。** diff 行渲染 `查看变更` / `View change` 按钮，展开时变为 `收起变更` / `Hide change`。它位于 `+n -n` 统计之后的真实流中且不收缩，因此窄行会先裁剪路径，而控件始终可及。

**括号是装饰，留在 CSS 里。** `.operation::before` 与 `::after` 承载 `(` 与 `)`，词典只保存 `修改` / `Modified`。屏幕阅读器无论哪种方式都读作「路径 修改」，而不使用该包裹形式的 locale 可以自行去掉它，无需改代码。

**思考块在流式期间展开。** `ReasoningRow` 由 `running` 播种 `expanded`，于是流式思考直接显示正文；摘要行——及其跟随末尾的滚动——仍服务于折叠起来只看一行的读者。正文高度上限为次级字号的十行（`max-height: calc((20px + var(--dsh-content-font-delta-secondary, 0px)) * 10 + 8px)`）并在自身内部滚动，因为会话流同时呈现多个块，不受限的思考会把回复埋掉。

**结束只在状态跃迁时折叠一次。** 一个 effect 比对前一个 `running` 与当前值，仅在 `true -> false` 时折叠。以已结束状态挂载的块——每一条被回放的历史消息——保持折叠；而读者已重新展开的已结束思考，不会被后续渲染强行收起。流式期间正文跟随末尾，但读者一旦向上滚动离开底部即释放跟随，回看因此不会在句子中途被拽回。

**Bash 行的输出高度是一个阶段，由包装元素上的 `data-stage` 承载。** 该行以包装元素上的 `data-stage` 承载阶段，其上限由 `--dsl-terminal-line-height` 派生（`calc(var(--dsl-terminal-line-height) * 10)`），而非重复一个会随字体绑定漂移的像素高度。`maxLines` 全程保持 `Infinity`：原语自身的 `maxLines` 折叠的是长输出的**中段**，与本行想要的滚动是不同的手势。

按此处上线的形态，该行有三个阶段——折叠行上的 `peek`、展开后的十行 `full`、以及越过上限的 `all`——并且在每一阶段都渲染终端卡片。[工具行折叠行为收敛到一份生命周期契约](../bug-fix/2026-09-04-web-row-lifecycle-disclosure.zh.md) 之后移除了 `peek`：已结算的 bash 行如今像其他所有工具行一样折叠为一行摘要，卡片随 `open` 挂载与卸载。十行上限、`all` 阶段及其下方的控件均未改变。

该控件仅在输出高于十行上限时出现——只打印了两行的命令没有「更多」可达；从折叠行请求「查看全部」会先展开到十行，读者不会被直接丢进一张不受限的卡片。从十行可进入不受限，之后再点则把上限收回，而不是让行卡在展开状态。

**同一个 turn 内只有流式块会展开。** `AssistantMarkdown` 传入 `running={streaming && i === last}`，因此带多个思考块的 turn 只展开最后一个，先前的保持折叠；每个块各自持有状态，于是某个块结束折叠时不会扰动其他块。重新展开会重新取得末尾跟随，因此仍在到达中的思考显示其最新一行，而非早前向上滚动所停留的位置。

**Trajectory 未受影响。** `packages/client/ui-trajectory/src/client/index.ts` 注册的 `id: 'trajectory'` 视图通过 `TrajectoryCell` 组装自己的记录，不复用 `ToolRow`、`FileMutationRow`、`BashRow` 或 `ReasoningRow` 中的任何一个，因此本次改动没有任何代码触达它。

## Alternatives considered

**从调用参数而非所呈现的 hunk 推导操作类型。** 被否决：`write` 的参数中不含前一版本，因此在那一层无法区分创建与覆盖。Host presenter 的元数据是唯一存在该区别的地方，而它也正是本行所呈现的内容。

**把括号放进词典（`'(修改)'`）。** 被否决：这会让一个包裹符号变成翻译义务，不采用它的 locale 无法去掉它，且每个新增操作词条都得记住这一约定。CSS 负责装饰，词典负责文字。

**保持思考块默认折叠，只加宽摘要。** 被否决：流式摘要是可能长达数百行的思考中的一行。需求是观看思考过程，这需要正文。

**在每次 `running` 为 false 的渲染中折叠思考块。** 被否决：那会在读者刚展开的瞬间把已结束的思考拍上。仅在跃迁时折叠（用 ref 追踪）只需四行，且把控制权留给读者。

**Bash 用两态而非三态（两行，然后不受限）。** 被否决：这会丢掉十行上限，而那正是防止长命令占据视口的性质。第三态的存在恰恰是为了让读者主动选择越过上限。

**用 `maxLines` 而非 CSS 高度为终端设限。** 被否决：`maxLines` 驱动的是 `headTailCap`，它丢弃输出的**中段**并显示 `… 其余 N 行` 开关——那是截断，不是本行所需的滚动。原语已在 `.output` 上暴露 `--dsl-terminal-output-max-height` 与 `overflow-y: auto`，正是所要求的滚动语义。

**仅在展开时渲染终端（原行为），只改上限。** 此处被否决：那会让折叠行无法回答「它打印了什么」，而这正是命令行最常被问到的问题。显示两行不需要读者付出任何展开成本。该否决在两天后被反转——折完仍显示输出框读起来就不算折叠，这正是[工具行折叠行为收敛到一份生命周期契约](../bug-fix/2026-09-04-web-row-lifecycle-disclosure.zh.md) 所记录的那份报告。

**为视觉一致对 Trajectory 视图做同样处理。** 作为范围被否决，而非作为目标被否决：两个视图不共享任何行组件，一致化意味着在一套不同的记录模型上把同样三个特性再实现一遍。若两个视图将来共用行原语，再行 revisiting。

## Consequences

两个既有测试编码了旧的 Bash 契约——终端卡片在行展开之前不存在——现已改为断言 stage 属性，因为卡片当时在每个阶段都存在，只有高度在变。`assembly-surfaces` 中覆盖 keyed 行到达终端卡片的用例同理。后来 `peek` 被移除，这些测试重新断言卡片的缺失；见[工具行折叠行为收敛到一份生命周期契约](../bug-fix/2026-09-04-web-row-lifecycle-disclosure.zh.md)。

未被折叠的流式思考块现在显示正文而非末尾行，因此跟随末尾的摘要滚动仅在折叠后可达。这一取舍正是改动的目的；折叠路径保留了该行为，`reasoning-row.client.spec.tsx` 同时钉住了两条路径。

十行上限是 CSS 文本，jsdom 无法布局，因此由 `chat-font-axis-styles.client.spec.ts` 与 `tool-row-styles.client.spec.ts` 断言其声明——包括该上限派生自 `--dsl-terminal-line-height`，而非重述一个像素高度。状态机自身由 `terminal-card.client.spec.tsx` 钉住，它走完 `full -> all` 再折返。

在折叠行上显示终端带来了此前不存在的 DOM 成本：每个阶段都会挂载全部输出行，而过去折叠行只渲染一行摘要。该上限是纯视觉的——`overflow` 隐藏超出部分而不从树上移除——因此成本的上界是会话中最长的一次输出，而非读者打开过什么。移除 `peek` 同时也注销了这项成本；见[工具行折叠行为收敛到一份生命周期契约](../bug-fix/2026-09-04-web-row-lifecycle-disclosure.zh.md)。

`FileOperation` 随 `deleted` 一起发布，而当前已发布的任何工具都无法产生该状态。它只是一个预留成员与一对词条，此处记录其不可达，既为免读者误认为它是受支持的状态，也为让下一位读者知道删除工具必须落在何处。
