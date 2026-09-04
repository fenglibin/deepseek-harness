# 代理说明：工具输出与深度思考跟随设置字号，而不再读次级档

状态：已实现

[English](2026-09-03-tool-output-and-thinking-read-body-font-size.md) | 中文

## 问题

设置 → 通用设置 → 字号大小给出的只有一个数字，而读者都会把它理解成「会话的字号」。有两处内容没有跟随它。

**工具输出固定在 11px。** IN/OUT 卡片、终端卡片、代码正文，以及 diff/read/search 的正文，读的都是 `--dsw-font-markdown-code-block-small`（11px/16px）或 `--dsw-font-markdown-code-block`（11px/19px）——这些 Figma 阶梯 token 里没有字号轴。把设置调到 17px 只会让叙述正文变大，而由它产生的工具输出仍是 11px。为了可读性而调大字号的用户，在最难读的那部分内容上——命令输出、diff、源码片段——得不到任何改善。

**工具行与深度思考行比正文低一档。** 这两行上的所有文字——标题、摘要、路径、diff 增减计数、折叠时的思考摘要——都读 `--dsh-content-font-size-secondary`（设置 ≤14 时减 1，>14 时减 2），思考正文还用次级增量单独设了 20px 行高。次级档本身没有问题，它是为流内元信息准备的（消息时间、统计胶囊、命令摘要）；但落在这两行上时，它把一行的标题与紧挨着的摘要拆成了两种大小，也让思考内容比它下面的回复更小。

两者当初都是有意的分级决策，但读起来都像是设置失效了。

## 决策

**新增一个 token，把正文字号带进等宽族。** [`gradient-shadow-text.css`](../../../../packages/client/ui-theme/src/styles/gradient-shadow-text.css) 新增 `--dsh-content-font-code`：正文字号与正文行高（`calc(24px + var(--dsh-content-font-delta))`），字族为 `--ds-font-family-code`。它只换字族、不换度量，因此任何采用点都不可能在「跟随轴」的同时又悄悄把字号改小。

**只绘制工具卡片的 primitive 默认改用该 token。** [`TerminalBlock`](../../../../packages/client/ui-primitives/src/TerminalBlock.module.css)、[`DiffBlock`](../../../../packages/client/ui-primitives/src/DiffBlock.module.css)、[`ReadBlock`](../../../../packages/client/ui-primitives/src/ReadBlock.module.css)、[`SearchBlock`](../../../../packages/client/ui-primitives/src/SearchBlock.module.css) 的正文字体与行高变量都取该 token；[`WebBlock`](../../../../packages/client/ui-primitives/src/WebBlock.module.css) 把结果标题、摘要片段和 fetch URL 绑到正文字号，因为它们是当散文读的，不是代码。这四个组件当前只被 `ui-tool` 使用，所以它们的默认值就是工具卡片的呈现，无需任何消费方重绑定。原本把它们压小的消费方——[`ToolRow.module.css`](../../../../packages/client/ui-tool/src/client/tool/components/ToolRow.module.css) 的 `.codeBody`/`.terminalBody` 与 [`bash-sample.module.css`](../../../../packages/client/ui-tool/src/client/tool/toolviews/bash-sample.module.css) 的 `.terminal`——删掉这些重绑定；`CodeBlock` 保留自己偏小的默认值，因为 markdown 代码块与它共用。

**这两行改为重绑定共享标题变量，而不是取消次级档。** [`DisclosureRow`](../../../../packages/client/ui-primitives/src/DisclosureRow.module.css) 新增 `--dsl-disclosure-title-font-size`，默认取次级档，并在 `.title` 里读它。`ToolRow` 与 [`ReasoningRow`](../../../../packages/client/ui-chat/src/client/chat/ReasoningRow.module.css) 在自己的根节点上把它重绑定为 `--dsh-content-font-size`。次级档留在它该在的地方——命令卡、上下文注入、系统提示、workflow 面板继续用元信息字号——而整行都按正文字号阅读的行，其标题随之一起提升。

**这两行上的其余文字也一并提到正文字号。** `ToolRow` 的摘要、摘要后缀、文件链接、操作限定词、变更开关都读 `--dsh-content-font-size`；diff 行的 `+/-` 计数仍比它小 2px，因为等宽数字在同字号下视觉上比旁边的无衬线路径更大。`ReasoningRow` 的摘要与 `thinkBody` 读正文字号与正文行高，思考正文的十行上限改为 `calc((24px + var(--dsh-content-font-delta)) * 10 + 8px)`。

**read 卡片的行号列不再是固定 48px。** [`ReadBlock`](../../../../packages/client/ui-primitives/src/ReadBlock.module.css) 把它改为 `max(48px, calc(4ch + 14px))`。`ch` 按行自身的字号解析，因此在 17px 下这一列仍放得下四位数字——固定 48px 在这里会溢出到正文区；48px 下限是 Figma 的宽度，小字号设置保持这个宽度而不是把它收窄。

## 考虑过的替代方案

**把 `--dsh-content-font-size-secondary` 重定义为等于正文字号。** 否决：次级档对共用它的元信息是正确的，取消它会把消息时间、统计胶囊、命令摘要、markdown 表格一起放大，等于让一个变量承担两种职责。

**把 `DisclosureRow` 的 `.title` 对所有消费方都改成正文字号。** 否决：那正是次级档仅存的归属。命令卡与上下文注入行是元信息行，把它们的标题改成正文字号只会把抱怨转移到用户没有提到的那些行上。

**从 `ToolRow` 侧重绑定 primitive 字体，而不改它们的默认值。** 对那四个工具专用 primitive 予以否决：重绑定是第二处需要同步的地方，而这四个的每一个消费方都是工具卡片。`CodeBlock` 保留该做法，因为 markdown 代码块也在渲染它。

**只对齐字号，代码行高保持紧凑（20px + delta）。** 否决：用户明确要求行高也与正文一致；更紧的行高会让放大后的输出读起来像另一种更密的版式，而不是同一段文字。

**卡片 banner 上的装饰（复制按钮、路径标签、语言标签）保留自己的字号。** 保留：它们是卡片家具，不是输出内容。它们挨着控件出现、不作为散文阅读，而且次级档的浅色调本来就在那里起作用。

## 影响

现在一个设置统管整个会话：调大字号会同时放大叙述正文、工具输出、命令输出、diff、源码片段、搜索结果、网页结果与思考内容。代价是密度——终端卡片在 224px 内原本能显示十行 11px 输出，现在 14px 下约显示九行；十行的思考内容也因为行高变大而更高。这两点都是预期的取舍：用户要的是统一的字号，而不是更多的行数。

`--dsh-content-font-code` 从此是「等宽族内容跟随设置」的接缝，`--dsl-disclosure-title-font-size` 是「整行按正文字号阅读的行」的接缝。

## 测试

- `tool-row-styles.client.spec.ts` —— 摘要、摘要后缀、文件链接读 `--dsh-content-font-size`；`.root` 重绑定 `--dsl-disclosure-title-font-size`；bash 行的输出上限仍由 `var(--dsl-terminal-line-height)` 推导，且不再重绑定字体度量。
- `chat-font-axis-styles.client.spec.ts` —— 思考摘要与正文读正文字号与正文行高，`.root` 重绑定标题变量，十行上限跟随正文行高。
- `disclosure-row-styles.client.spec.ts` —— `.title` 读可重绑定变量，`.root` 将其默认为次级档。
- `apps/web/tests/settings-chrome.e2e.ts` —— 字号步进用例在真实引擎中探测 `--dsh-content-font-code`（`min`/`max`/`calc` 才会真正求值的地方）：默认 14px，上调两档后为 16px。CSS 文本断言只能钉住声明，这条断言钉住的是「工具卡片读取的度量就是设置值」，而不是某个阶梯字号。
- `packages/client` 全量：3972 通过，1 失败。失败项是 `ui-theme/tests/scrollbar-styles.client.spec.ts` 针对 `UserTurnPanel.module.css`，本次改动未触及该文件；它是本分支上既有的失败，[2026-09-03-chat-ux-resize-menu-file-rows.zh.md](2026-09-03-chat-ux-resize-menu-file-rows.zh.md) 已有记录。

## 暂缓

其余仍读次级档的界面——命令卡、上下文注入、系统提示行、统计胶囊、消息时间、workflow 面板——保持元信息字号。用户没有提到它们，它们是家具而非内容；是否统一它们，取决于「元信息档是否还应该存在」，是另一个独立的决策。
