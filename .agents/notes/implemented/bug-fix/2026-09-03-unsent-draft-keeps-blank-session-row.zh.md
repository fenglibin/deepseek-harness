# Agent Note: 未发送的输入草稿会保留其空白 Session 行

Status: implemented

[English](2026-09-03-unsent-draft-keeps-blank-session-row.md) | 中文

## Problem

Workspace 浏览器只在空白 Session 处于选中状态时列出它，因此临时**新会话**行的存活时间恰好等于读者停留其上的时间。在该行输入提示词后切换到另一个 Session，该行就会消失：输入的文本仍留在按 Session id 键控的草稿存储中，但没有任何一行能回到它，于是要继续这个念头只能记住该 id 或者重新来过。

草稿归属于 `ui-conversation`，可见性规则归属于 `ui-workspace`。feature 插件不得在运行时 import 另一个 feature 插件的值，因此这两个事实必须通过注入的服务相遇，而不是共享模块。

## Decision

`ui-workspace` 持有注册表，并把它作为 root 级 observable 发布。`UiWorkspaceService` 新增了 `noteDraft(sessionId, draft)` 和一个 `drafts: HostObservable<ReadonlySet<SessionId>>`，其快照身份在成员真正变化前保持稳定；纯空白草稿会被 trim 成空串，因此永远不会占住一行；`deleteSession` 在 Host 接受删除后剔除该 id。该服务的 `apply` 通过 `ctx.slots.provideRoot` 贡献 `sessionDrafts`，消费方以 `useSessionDrafts` 读取。`tree.ts` 在该集合包含某空白 Session 时保留该行，`WorkspaceBrowser` 把这个 hook 传入分组、平铺与搜索三处派生。

写入由 `ui-conversation` 负责：它的 `bindDraftMirror` inject face 现在把每次镜像到的草稿变化同时发往两个下游——按 Session 持久化的存储，以及 `ctx.uiWorkspace.noteDraft`——复用的是它已经注入的那条服务边。`ui-conversation` 在自己的 `inject` 中声明 `uiWorkspace`，而 `ui-workspace` 不得反向声明 `uiConversation`：那样两者会互相等待、永久挂起。

## Alternatives considered

**由 `ui-conversation` 自己发布该 root hook。** 否决：只在提供方挂载期间才绑定的 root hook，会让 `materializeStandardBinding` 拿不到 `useSessionDrafts` 键，而第一个在 hook 缺失时渲染的消费方会崩溃——这是一个激活顺序 bug，而不是"缺一个事实"。

**让 `ui-workspace` 从 `ui-conversation` 读草稿存储。** 否决：它需要把 `uiConversation` 写进 `inject`，从而闭合上面的环；而且它把一个不属于自己的写操作交给了浏览界面。

**任何曾经输入过的空白 Session 都保留该行。** 否决：它会为已经发送或已丢弃的草稿复活行，而这正是临时行存在的意义所要避免的。注册表以实时草稿为键，因此清空输入框即让该行消失。

## Consequences

带未发送内容的空白 Session 在所有分组视图和平铺列表中都保持可达，清空输入框或删除该 Session 后该行消失。搜索仍然从不匹配空白行，因此多出来的这一行不可能通过查询浮出水面。注册表的代价是每次成员变化复制一次 `Set`，并且每个浏览器派生函数现在都多接收一个集合参数。
