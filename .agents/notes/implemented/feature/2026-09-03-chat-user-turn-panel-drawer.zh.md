# Agent Note: Chat 界面新增用户消息抽屉，与右侧导航条同步

Status: implemented

[English](2026-09-03-chat-user-turn-panel-drawer.md) | 中文

## 问题

真正的 Chat 会话动辄几十轮，把它们当作一条平面滚动条读毫无效率。Chat 视图早就有 [`TurnNavigator`](../../../../packages/client/ui-chat/src/client/chat/TurnNavigator.tsx) 这个紧凑的右侧导航条——每个已加载 turn 一个小刻度，点击跳转到对应位置——但它只有 28 像素宽，每个刻度只在 hover 时展开两条短预览行。想要"翻一翻自己之前提过哪些问题、哪一轮要求切换成 Compact 模式"的真实用例，必须一个一个 hover 才能读到内容，速度太慢。

导航条读数正好是用户想要的列表形式：`ChatTurnNavigationIndex` 已经把每个已加载 turn 投影成 `{ turn, anchorKey, prompt, response }`，`navigateToTurn` 也能滚动到任意 turn。缺的只是一份面板大小的、能整段阅读的呈现形式。

## 决定

**新增一个纯客户端组件 [`UserTurnPanel`](../../../../packages/client/ui-chat/src/client/chat/UserTurnPanel.tsx)，与 `TurnNavigator` 同处 Chat scrollport 内，渲染一个圆形 badge 或一个垂直抽屉二选一。** 两个组件读同一个 `turnNavigationItems` selector 与同一个 `activeTurn` state，因此 badge 计数、抽屉列表、导航条刻度、当前高亮行四者天然同步。组件本身只是 `div` / `button` / `ol` / `li` 的普通 React 树——不注册 slot、不定义 service contract、不开新字典命名空间，只在 `locale.ts` 加四条 `chat.userTurnList.*` 本地化键。

**过滤是反应式的、按情形过滤，不是按 kind 过滤。** `prompt` 为空的 turn——已加载窗口从该轮中间切入、压缩总结里的纯 assistant 步骤、未知面——不属于用户消息，自动从抽屉里隐去；其余按时间线顺序渲染。badge 在空 session 里也整体不挂载，避免空 session 看到这块新 chrome。

**外点关闭复用 [`useDismissOnOutsidePointer`](../../../../packages/client/ui-primitives/src/useDismissOnOutsidePointer.ts)，Esc 关闭是一行 `document.keydown` 的 `useEffect`。** 两者在 close 时都会解绑。选中某行后把 item 回传给 ChatView 并立刻关闭，符合任何 popover 菜单的 affordance：新 chrome 永远不会一直占着屏幕挡住用户验证跳转结果。

## 拒绝的方案

**给现有导航条每格加一行预览和点击区域。** 拒绝：导航条按设计就是 28 像素的固定列（滚动时给读者连续可视反馈），拓宽它会和 Chat 列与输入框共享的宽度轴打架。面板应当是独立组件，不是更宽的导航条。

**把抽屉升格成 `Modal` 组件。** 拒绝：`Modal` 一开就独占全屏，用户却想同时看见后面对话内容（预览下一轮、阅读时滚动）。`role="dialog"` + `aria-modal="false"` 是该场景的正解。

**badge 计数用整个 session——含未加载历史——的用户消息总数。** 拒绝：当前界面所有导航小部件——导航条、"加载更早"按钮、`activeTurn`——都基于已加载窗口，UI 文案也是这一套（"加载更早以查看更早的 turn"）。一个暗中数未加载 turn 的抽屉会引入第二条隐式的真相源，破坏可观察性。

## 后果

有 17 条用户消息的 session，读者会看到一个 #17 圆形 badge，正好挂在导航条所在位置；点一下展开成按时间线排列的列表，每行是用户消息的首行预览；再点任意一行跳转到对应位置并把面板折起。本次改动只动 `packages/client/ui-chat/src/client/chat` 三个文件、`locale.ts` 四条键、新增一份含六条 spec 的单元测试，不触碰任何下游 package。

代价是一个小 chrome 必须与导航条保持一致。两个组件读同一个 `useChat(s => s.navigation.items())` selector 与同一个 `activeTurn` state——抽屉寄生于导航条的不变量而非自己重新推导——所以未来任何对 Chat 快照 turn 导航投影的改动会同时落在两侧。六条单元测试钉住读者能看到的四种行为（badge 计数、列表顺序、过滤后列表大小、点行 → 跳转 + 关闭、外点/Esc 关闭、空 session 不挂载），原有的 `chat-view.client.spec.tsx` 76 条用例保持不变——那是用来罩住接线变更的回归网。
