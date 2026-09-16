---
description: "Web GUI 的会话变更文件 dock：把本会话内模型通过写入/编辑工具产生的文件变更折叠为一份会话级、按首次出现排序的列表，提供「当前变更」与「全部变更」两个视图，接受记录按会话持久保存；面向会话交付体验的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-changes

## 概述

本包在 Web GUI 的会话输入 dock 条带中渲染「修改的文件」列表。列表的首选来源是宿主 `changedFiles` 投影，它折叠**完整**的持久会话日志，因此客户端分页了多少历史都不影响结果；投影缺席时回退到 `useConversation` 读到的已加载窗口。每一行展示文件的完整路径并可通过宿主桌面打开。列表提供「当前变更」与「全部变更」两个视图：接受一个文件把它从前者移到后者的「已接受」行，磁盘上的内容不会改变；该文件此后被 agent 再次改动时会回到「当前变更」。接受记录由会话级 store 持久保存，因此跨组件重挂载、跨会话往返与跨页面刷新都保持。拒绝被有意排除在范围之外：不存在逐调用的先前内容快照可用于回滚文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件与 `ui-conversation`、`ui-session`、`ui-deliverables` 一起挂载，并挂载提供 `changedFiles` 的 `dsh-file-changes`。dock 随即出现在会话输入条带中，位于 todo 与 goal dock 之上——会话的变更文件是最宽泛的摘要，因此排在条带首位。本会话改动过文件时显示列表；从未改动过时不渲染。

### 接受

每个待处理文件行提供「接受」按钮，把它从「当前变更」视图移除；「全部接受」按钮一次清除当前全部待处理文件。接受只作用于界面，不删除磁盘上的任何文件。已接受的文件仍留在「全部变更」视图中，并标记为「已接受」。

接受记的是**读者当时看到的那个变更**（该文件的 `lastSeq`），不是「这个文件永远不再出现」：该文件此后只要被 agent 成功改动一次，它就回到「当前变更」。「全部接受」是同一规则的一次批量应用。

### 当前变更 / 全部变更

展开列表后可在两个视图间切换。「当前变更」只列出尚未被接受（或已被更新的变更超越）的文件；「全部变更」列出本会话曾变更过的全部文件，包含已被接受的文件。一个文件在接受之后又被改动时，会同时出现在两个视图中。

当前变更清空后 dock 仍以一行摘要保留入口，因此全部接受之后仍能切到「全部变更」查看此前的文件。

### 打开

每一行是一枚按钮，展示文件相对工作区根的路径（目录段可压缩省略，文件名段始终完整；工作区外的文件保留绝对路径），悬停时显示绝对路径，点击后以该绝对路径经 `session.openWorkspacePath` 交给宿主桌面打开。宿主拒绝时（例如远端环境没有可用的打开程序），列表下方出现一行失败原因，下一次成功打开时该行消失。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

列表的首选数据源是宿主 `changedFiles` 投影（见 [`dsh-file-changes`](../../fs/file-changes/README.zh.md)），它折叠**完整**的持久会话日志。客户端只能加载尾部窗口，窗口之外的轮次连边界事件都不在，所以客户端自己的折叠在长会话里会漏掉早期改动——这正是把全量事实放到宿主的原因。投影缺席（组合里没有投影注册表）时，dock 回退到 `sessionChanges` 的窗口折叠，两者产出同一形状，因此下游无从分辨是谁回答的。

`canonicalMutationPath` 先把工具调用写下的路径按会话 cwd 解析为绝对路径，再统一分隔符并消解 `.`/`..` 与重复斜杠；模型对同一文件混用绝对与工作区相对拼写，规范化是它只占一条的原因。宿主折叠与这里读的是同一份规范化实现。

接受记录由 dock 条目注册时声明的会话作用域 store 持有（`accept-store.ts` 的 `createAcceptedChangesStore`）。`conversation.input.dock` 的作用域是 `session`，因此框架按会话缓存实例：同一会话内重挂载复用同一实例，切换会话使用另一实例，会话消亡时框架调用 `clearPersisted` 清掉存储键。记录不能放在组件本地——组件本地状态在作用域重绑定时按构造清空，会让接受过的文件整批复活。store 声明了 `persist`，框架把会话 id 加为键后缀，因此刷新后每个会话各自恢复自己的接受记录。

两个视图由同一份投影数据与同一份接受记录派生：当前变更是「该路径没有接受记录，或其 `lastSeq` 大于已接受的 seq」，全部变更是投影的全量。历史在数据上就是接受记录的键集合，因此接受并不搬移任何条目——谓词一变，两个视图同时反映。「全部变更」中的已接受行展示该路径的当前状态，不冻结接受时刻的快照。

`isPendingChange` 是上述比较的唯一归属方，`pendingChanges` 与行内接受控件都读它，避免规则被复述成两份。

打开能力来自注册时注入的 `SessionChangesInjected`：`cwd` 取自 `sessions.list` 的会话工作区根，`openFile` 只把行内已规范化的绝对路径转给 `remote.session.openWorkspacePath`（组合里若挂载了文件查看器，则改由它按会话工作区打开）。行内文本经 `displayPath(path, cwd)` 去掉工作区根前缀——绝对路径是折叠与打开用的身份，相对拼写才是读者在仓库里导航用的写法；工作区外的文件没有更短的命名方式，保留绝对路径。插件不发出 cordis 事件，卸载随插件 fiber（HMR 安全）；其声明的 store 实例由框架按会话作用域管理。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当变更文件列表不够时阅读这些页面。

- [ui-deliverables](../ui-deliverables/README.zh.md) — 累积 `deliverables` 词汇的相邻包。
- [dsh-file-changes](../../fs/file-changes/README.zh.md) — 提供 `changedFiles` 全量投影并拥有共享变更词汇的宿主包。
- [ui-conversation](../ui-conversation/README.zh.md) — 声明 `conversation.input.dock` 槽位并拥有 composer。
- [ui-session](../ui-session/README.zh.md) — 提供 `useConversation` 会话标准 seat。
- [客户端包地图](../README.zh.md) — 相邻的浏览器 UI 包。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些限制定义了当前的变更文件界面。它们是当前包约束，不是任务待办。

- **无拒绝/回滚** — 接受只是界面清除；不存在逐调用的先前内容快照可用于回滚，因此「拒绝」被有意排除在范围之外。
- **仅列出已声明变更** — 只显示 `write`、`edit` 与 `str_replace_editor` 的成功变更；模型以其他方式（如 `bash`）改动的文件不会被列出。判定归 `dsh-file-changes` 所有。
- **首次出现折叠** — 同一文件在会话内只保留一条，展示最早的操作类型；后续变更只推进该条目的 `lastSeq`（这正是「接受后再次改动会重新出现」的依据）。规范化只统一拼写（相对/绝对、分隔符、`.`/`..`），不解析符号链接，因此指向同一文件的两条不同符号链接路径仍会各占一行。
- **接受记录按绝对路径持久化** — 记录存在浏览器 localStorage 的 `dsh.session-changes.accepted.<会话 id>` 下，因此工作区被移动后旧标记失效，表现为文件重新出现。
- **记录随会话作用域存活** — 切换到别的会话再切回、以及页面刷新都保留记录；会话被移出列表后其作用域连同存储键一并被回收，该会话的记录不再恢复。
- **seq 回退即视为已接受** — 会话日志被修复或回滚后，同一路径的新变更若 `seq` 不大于已接受的 `seq`，会被判为已接受；比较是 seq 单调比较，不做内容比对。
- **回退到窗口折叠时只覆盖已加载历史** — 没有 `changedFiles` 投影的组合里，列表只反映客户端已分页进来的轮次，长会话会少报早期改动。
- **打开能力由宿主决定** — 行内按钮不预检 `canOpenWorkspacePath`；宿主无法打开时点击会返回失败原因，而不是按钮缺席。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
