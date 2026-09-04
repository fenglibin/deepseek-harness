# Agent Note: 输入框在所有稳定阶段都可调整高度、模型入口直达模型列表、改文件的工具行带侧边色条

Status: implemented

[English](2026-09-03-chat-ux-resize-menu-file-rows.md) | 中文

## Problem

日常使用 Chat 界面时收集到的三个问题，都与输入框及其周围的会话记录有关。

**新建会话的输入框不能调整高度。** 点击"新会话"进入居中的 hero 输入框，它不渲染高度手柄。用户刚在上一个会话里把底部输入框拖到 400px，新建会话后拿到一个固定高度的框，且无法重复这个拖拽动作。两个输入框是同一张输入卡片的两种摆放位置，却只有一个响应拖拽。

**模型入口需要两次点击才能看到模型。** 输入框的模型触发器打开的是一个两行根菜单——"模型"行和"推理等级"行，每行都是标签加当前值加一个箭头——真正的模型列表还要再钻取一层。于是换模型必然多花一次点击，还要多读一行只写着"模型"和触发器上已经显示的名字的内容。

**`write` 与 `edit` 行和其它工具行长得一样。** 在长会话记录里，改动了文件的行与周围的 `read`、`search`、`bash` 行使用相同的图标色和标题色。唯一能看出文件被改动的线索藏在展开后的卡片里，快速浏览折叠行的读者无法判断哪些轮次动过工作区。

## Decision

**高度手柄在所有稳定阶段都提供，而不只在停靠态提供。** [`ConversationRoot`](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx) 把 `HeightHandle` 的渲染条件从 `phase === 'active'` 改为 `phase !== 'settling'`，[`InputBar.module.css`](../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.module.css) 删除了让 hero 输入框忽略拖拽偏好的 `.hero .scroll { height: auto }` 覆盖。高度链路的其余部分本来就与阶段无关，无需改动：`publishSizes()` 从 localStorage 读 `dsh.conversation.composerHeight` 并写入根元素的 `--dsh-composer-user-height`，`resolveComposerHeight()` 把它钳制在 `[96, root.clientHeight − 240]`。hero 卡片保留自己的 52px `min-height` 下限，因此拖到更小也不会把胶囊压塌。宽度手柄仍然只在停靠态出现，因为 hero 阶段没有需要调整宽度的会话记录列。

**模型入口直接打开模型列表。** [`ModelSelect`](../../../../packages/client/ui-model-selection/src/client/ModelSelect.tsx) 的 `Pane` 类型去掉 `'root'` 成员；`show()` 与 `close()` 都落在 `'model'`，`Escape` 先从 `'effort'` 退回 `'model'`，再按一次才关闭菜单。推理等级变成模型列表**内部**的一行，放在分组滚动容器之上，因此无论目录滚动到哪里，当前等级都保持可达；推理等级面板新增一行返回，指针用户不会困在钻取层里。`menu.model` 键随它所标注的那一行一起删除；`menu.back` 作为返回行的文案加入字典。

**`write` 与 `edit` 行带一条业务主色侧边色条。** 强调效果全部在 [`ToolRow.module.css`](../../../../packages/client/ui-tool/src/client/tool/components/ToolRow.module.css) 里以纯 CSS 实现，挂在 `ToolRow` 本来就会输出的 `data-variant` 属性上：2px 的 `--dsw-alias-state-business-primary` 左侧色条，同样的强调色施加在 `.leading`、`.title`、`.sep` 上，再加一层实心 hover 填充。色条通过 `margin-left: -8px` 悬挂到会话记录的侧边内边距里，再用等量的 `padding-left: 6px` 在内侧补回来——`-8 + 2 + 6 = 0`，因此该行文字与所有其它行保持对齐，24px 的单行高度也未被触碰。

## Alternatives considered

**手柄只保留在停靠态，让 hero 输入框按内容自动增高。** 否决：用户抱怨的正是两个输入框行为不一致。一个偏好、一个手柄、一套钳制——hero 卡片就是同一张输入卡片摆在另一个位置。

**在 hero 阶段渲染手柄，但保留 `.hero .scroll { height: auto }`。** 否决：这样手柄会移动并持久化一个 hero 输入框静默忽略的偏好。拖了却看不到效果，比没有手柄更糟。

**保留根菜单，让鼠标悬停在"模型"行上时打开模型列表。** 否决：悬停打开在触屏上不可达，而且会给一个已经有点击和键盘两条路径的菜单再增加第三种交互模型。

**去掉推理等级面板，把等级直接内联进模型列表。** 否决：等级列表是一个只对当前模型生效的扁平单选组。内联会每次打开都把目录挤到折叠线以下，并且把两个单选组放进同一个 `role="menu"`。

**不加返回行，靠 `Escape` 和重新点击触发器退出。** 否决：`Escape` 只对键盘可用，而重新点击触发器会关闭菜单。钻进推理等级的指针用户将没有回到列表的路。

**只通过前置图标来强调改动文件的行。** 否决：图标是 16px 的字形。在大多数行都折叠、靠扫视阅读的会话记录里，一条贯穿整行高度的 2px 色条比图标着色更容易一眼看到。

**把整行缩进，而不是把色条悬挂到外侧留白。** 否决：这会让 `write` 和 `edit` 行在同一份会话记录里比其它行右移 6px，等于用水平对齐的破坏换垂直对齐的破坏。

**hover 填充用半透明色。** 否决：行后面的会话记录会透出来。`--dsw-alias-interactive-bg-hover-solid` 是客户端其它地方为此专门使用的令牌。

## Consequences

把输入框拖到 400px 的用户，在下一次新建会话时看到的也是 400px，且两种形态下用的是同一个手柄。换模型变成一次点击打开列表、一次点击选中模型；推理等级是列表内多出来的一行，退出则靠一行返回。`write` 与 `edit` 行被一条品牌色侧边色条与周围的读取和搜索行区分开来，行高与文字对齐均未改变。

代价是两种输入框形态共享同一个偏好：为停靠态拖出的高度现在也会决定 hero 卡片的高度。这正是用户所要求的，但它确实意味着上次拖过较大高度的用户，hero 卡片可能开得比内容更高。重置手势（`onHeightReset`）会一次性清掉两者的偏好。

第 6 项是纯 CSS，因此没有测试断言色条的像素值。测试锁定的是它所依赖的挂钩：`GenericToolCard` 会渲染 `data-variant="edit"` 与 `data-variant="write"`，这一点在 `tool-row.client.spec.tsx` 中已有断言。

## Testing

- `skeleton.client.spec.tsx` —— hero 阶段渲染高度手柄（同一棵树里同时有 `data-phase="hero"` 与 `[data-height-handle]`）；拖拽 → 持久化往返在 hero 手柄上跑通（基准 336px，−40 时实时值 376px，落盘到 `dsh.conversation.composerHeight` 为 396）；settling 阶段不渲染手柄。
- `model-select.client.spec.tsx` —— 一次点击即到达模型列表，且推理等级行就在列表内；推理等级行可钻取、返回行可退回；`Escape` 先从推理等级退回再关闭；钻取选中后重新打开，落在模型列表而不是推理等级。
- `packages/client` 全量：3850 通过，1 失败。失败项是 `ui-theme/tests/scrollbar-styles.client.spec.ts` 报在 `UserTurnPanel.module.css` 上，而本次改动没有碰这个文件——对它与 `packages/client/ui-theme` 执行 `git diff --stat` 结果为空——因此它是本分支上既有的失败。
- `tsc -b tsconfig.client.json`、对三个包执行 `run-oxlint.ts`、以及 `verify-client-ui-i18n.ts` 均通过。

## Deferred

同一次 UX 优化的其余三项分别单独提交：输出本地化（目前语言设置没有传导到模型输出）、带接受/拒绝的修改文件列表、以及抑制已被重试解决的错误。三者各自涉及不同的界面与各自的宿主侧工作，且都不与本批次共用代码。
