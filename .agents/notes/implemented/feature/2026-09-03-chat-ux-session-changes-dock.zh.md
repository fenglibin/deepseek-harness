# Agent Note: 会话级「修改的文件」dock，列出 agent 的改动并支持逐个接受

Status: implemented

[English](2026-09-03-chat-ux-session-changes-dock.md) | 中文

## Problem

此前没有一个地方能集中看到本次会话里 agent 到底改了哪些文件。每个 turn 的产物行（`ui-deliverables`）只列出单个收尾 turn 的输出，没有跨 turn 汇总，也没有需求里要求的「接受」动作。

## Decision

新增包 `packages/client/ui-session-changes`，向既有的 `conversation.input.dock`（composer 上方，todo / goal dock 之前）贡献一个 entry。这个 entry 把 per-turn 的 `deliverables` 词汇——`ui-deliverables` 已经从成功的 `write` / `edit` / `str_replace_editor` 调用里累积的产物——折叠成一张会话级、首次出现顺序的列表，并渲染一个可折叠/展开的卡片，带逐个文件的接受按钮和「全部接受」。

**数据层新增了操作类型。** `turn-deliverables.ts` 现在在每个产物路径旁记录 `MutationOperation`（`'write' | 'edit'`）——`write` 映射为 `'write'`，`edit` 和 `str_replace_editor` 映射为 `'edit'`——通过新的 `mutationTarget()` 解析器和 `producedChangesForClosing()` 读取器。既有的 `producedForClosing()` 不变，turn-tail 的 chip 照常工作；`producedChangesForClosing()` 是同样的去重、首次顺序折叠，但返回 `{ path, operation }` 供会话面板使用。

**UI 读 conversation，而不是新造一个 projection。** `SessionChangesDock`（adapter）通过 session 标准 `useConversation` 座位订阅，用 `producedChangesForClosing` 折叠 `conversation.views.get('chat').timeline.turns`，再渲染纯组件 `SessionChangesPanel`。面板持有组件本地的接受状态：接受一个文件只是把它从列表移除——磁盘上没有任何变化。纯组件 / adapter 的拆分对齐了 `ui-goal` 的 `GoalBar` / `GoalDock`，让面板可以在不涉及 `InputZone` owner 的情况下测试。

**拒绝被有意省略。** FS 工具下没有 per-call 的 prior-content 快照，真正的回滚不可能；确认的范围就是只做接受。

## Alternatives considered

**新增 session 级 `ConversationNodeDefinition`。** 否决：`deliverables` 已经通过 `buildLocationData` 发布了 per-turn 的改动，而 assembler 的 start/update 契约没有天然的 session 级 start 事件。在 UI 里折叠已发布的 turn 数据更简单，而且读的是同一份事实来源。

**做 session projection（像 `todos`）。** 否决：为单个消费者增加一个 host 侧累积器，而 conversation timeline 已经承载了这些数据。

**接受状态持久化到 settings。** 否决：确认的范围是「仅表面移除」；组件本地状态让改动更小、更可逆。

**真正的拒绝（回滚）。** 否决：没有快照，且用户确认「先不做拒绝」。

## Consequences

改动过文件的会话现在会显示一个停靠的「本次修改的文件 / Changed files」卡片：折叠时显示数量，展开时逐行列出每个文件（basename + 操作 + 接受），带「全部接受」。接受把该条目从表面清除而不动磁盘；全部接受后 dock 消失。列表把「先写入后又编辑」的文件去重为一条首次出现的条目，保留最早的操作类型。

代价是 composer 上方多了一个 input-dock entry，以及一个组件本地的接受集合——页面刷新后重置（刷新后会重新显示已接受的文件）。这两点都是 v1 的既定取舍。

## Testing

- `ui-deliverables/tests/produced-files.client.spec.tsx` —— 新增测试验证 `producedChangesForClosing` 对 `write`、`edit`、`str_replace_editor` 分别记录 `write` / `edit` / `edit`，且对缺失数据返回 `[]`。该包 32 条测试。
- `ui-session-changes/tests/session-changes-dock.client.spec.tsx` —— 7 条测试：折叠（跨 turn 首次顺序、保留最早操作、无 chat view / 空 timeline / 无 deliverables）、默认折叠后展开、逐个接受、全部接受后隐藏 dock。
- 两个包合计：39 通过，0 失败；lint 0 警告/错误；`tsc -b tsconfig.client.json` 对新包干净。

## Deferred

同一次 UX 打磨的其余项已全部完成；修改文件列表是最后一项，六项收尾。
