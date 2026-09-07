# Agent Note: 用户消息抽屉要把仅图片回合计入，并把无文案的行可视地标注出来

Status: implemented

## Problem

`turnOutline` projection（`packages/session/session-stats/src/turn-outline.ts`）把会话里每一个以自己发出的 `user/message` 收尾的回合折成一个预览，并把这个投影喂给聊天右侧的"我的对话"抽屉。`promptOf` 的判定把一个回合是否进入抽屉的依据收束在「首条 `user/message` 是不是带可预览文本」上：`source.kind === 'user'` 的首条消息只要没有文本块（譬如仅图、仅附件、或者根本就是空 content），就回空串，`apply` 在 `turn/end` 时把它当成"没有直接用户问句"丢弃掉。

聊天面板里的回合数是 host 从持久化层直接放出来的，不会跳过仅图回合；而抽屉的行数和 badge 都来自这条被丢弃的投影，于是在任何带过一轮"只发了张图"的会话里，badge 与抽屉列表永远比聊天面板少一。读者看到一共 `11` 条，但聊天最后一轮是 `第 12 轮`，第一次点击 `#11` 找到的是 `#12`，第一次点击 `#12` 也是 `#12`，抽屉映射失真。

落选的仅图回合同时还把它的 host 总数从抽屉里彻底抹掉，所以读者认为这条消息"不在列表里"，可能去手动加页或重新拉历史。它属于会话的一部分，应该被列出来，无论预览是什么。

`UserTurnPanel`（`packages/client/ui-chat/src/client/chat/UserTurnPanel.tsx`）渲染这条被丢回来的 prompt 时，没有专门的兜底。`trimPrompt(text)` 只在文本超长时省略号折叠，对空串就是空串。这意味着即使把投影修好，抽屉会真的画出一行只有 `#09` 标签、行体空白，让读者以为这一行没有渲染或没有交互。

## Decision

`turnOutlineProjectionDefinition.apply` 增加一项 `currentIsUserTurn: boolean` 字段，状态版本保持 1：

- `user/message`：原来的『首条文本 prompt』判定不变，依旧把 `currentPrompt` 写入；同时当 `event.data.source.kind === 'user'` 时把它合并进 `currentIsUserTurn`，无论这条消息是不是带文本（`source.kind !== 'user'` 的注入消息不会拉起这个标志位）。
- `turn/end`：保留回合的条件由 `currentPrompt !== ''` 单条判定放宽到「`currentPrompt !== ''` 或 `currentIsUserTurn`」——只要这两条用户信号任一成立，就把回合纳入，仍以原始的空串 `prompt` 入列。
- `turn/start` 与 `turn/end` 都把 `currentIsUserTurn` 重置回 `false`，行为闭环对齐现有翻页与继承。

`chat.userTurnList.previewEmpty` 新增文案「（无文本，仅附件）」，由 `UserTurnPanel` 的 `trimPrompt(text, t)` 在文本折叠为空时回退显示；其余预览与折叠规则保持原样（折叠后长度、长提示省略号、仅去前导空白）。

## Alternatives considered

**让 `promptOf` 自己把"仅图"消息当成空 prompt 然后在抽屉中改用其他字段补内容。** 否决：投影只导出 `prompt`，让 `promptOf` 临时把内容塞进 prompt 等于把仅图消息的预览偷偷塞进 projection 的对外字段，污染字段语义；其它消费者（调试、未来回放）也会拿到一个表面像"prompt"实际是图的字段。

**在 `turn/end` 时基于已落事件回放 content 块来决定回 fallback 而不是依赖 `currentIsUserTurn`。** 否决：`apply` 是逐事件纯函数，回放整段 turn 会把投影和事件流绑死，未来加新事件类型可能让回放丢失信息。在 `user/message` 上打一个 owner-only 标志位更直接、不依赖事件顺序。

**直接在抽屉里区分"消息已发送但无文本"与"根本没有这条消息"。** 否决：抽屉只看到投影出来的行，无法分辨 `prompt: ''` 字段是"仅图"还是投影未曾捕获；让投影承担"哪种 user message 算用户回合"的语义决定，把这条不可恢复的区分收敛到一个地方。

**给抽屉行画一个图标 + 短提示作为非文本标记。** 否决：抽屉行已经是一个紧凑行（`#03 / 标题预览`），新增图标需要变更 drawer 行布局、添加新 CSS 类与新 i18n key；当前的"折叠为空 → 落地为本地化兜底文本"路径对 95% 的桌面布局足够用，需要图标化的场景留给后续需求触发。

## Consequences

任何带过"仅图"或"空 content"用户消息的会话，抽屉 badge 与抽屉行的总数严格相等，且都与聊天面板里的回合数一一对齐。读者点 `#10` 找到 `#10`，不会被抽屉里的"下一条"骗到。空 prompt 行体显示「（无文本，仅附件）」，按钮仍然可点击，仍然能导航。

`packages/session/session-stats/src/turn-outline.ts` 状态版本保持 1：现有持久化产物（`SCHEMA_VERSION` 与 `SESSION_FORMAT_VERSION` 不动）的反序列化路径走的也是同一条 `apply`，旧会话重新挂上 host、再次投影时即可拿到正确的行数，不需要数据迁移。

`packages/client/ui-chat/tests/user-turn-panel.client.spec.tsx` 新增一条用例覆盖空 prompt 渲染。`packages/session/session-stats/tests/turn-outline.spec.ts` 新增两条用例：首条仅图消息的回合被纳入；首条注入消息 + 后续仅图 user 消息的回合被纳入。
