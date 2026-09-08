---
description: "Web GUI 的会话变更文件 dock：把本会话内模型通过写入/编辑工具产生的文件变更折叠为一份会话级、按首次出现排序的列表，并支持逐文件接受以从界面清除；面向会话交付体验的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-changes

## 概述

本包在 Web GUI 的会话输入 dock 条带中渲染「本次修改的文件」列表。它把每一轮的 `deliverables` 词汇——即 `ui-deliverables` 从成功的写入/编辑工具调用中累积的产物——折叠为一份会话级、按首次出现排序的列表，并通过会话标准的 `useConversation` seat 读取。每一行展示文件的完整路径并可通过宿主桌面打开。用户接受一个文件只会把它从界面清除（组件本地状态），磁盘上的内容不会改变。拒绝被有意排除在范围之外：不存在逐调用的先前内容快照可用于回滚文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件与 `ui-conversation`、`ui-session`、`ui-deliverables` 一起挂载。dock 随即出现在会话输入条带中，位于 todo 与 goal dock 之上——会话的变更文件是最宽泛的摘要，因此排在条带首位。存在未接受的变更时显示列表；全部接受后 dock 不再渲染。

### 接受

每个文件行提供「接受」按钮，把该文件加入本 dock 的接受集，从而从待处理列表中移除；「全部接受」按钮一次清除所有待处理文件。接受只作用于界面，不删除磁盘上的任何文件。

### 打开

每一行是一枚按钮，展示文件相对工作区根的路径（目录段可压缩省略，文件名段始终完整；工作区外的文件保留绝对路径），悬停时显示绝对路径，点击后以该绝对路径经 `session.openWorkspacePath` 交给宿主桌面打开。宿主拒绝时（例如远端环境没有可用的打开程序），列表下方出现一行失败原因，下一次成功打开时该行消失。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

`sessionChanges` 从会话的 `chat` 视图时间线遍历每一轮，读取 `deliverables` 词汇，按规范化后的 path 做 first-seen 折叠——同一文件先写入后编辑仍是一条，保留最早的 operation kind。`canonicalMutationPath` 先把工具调用写下的路径按会话 cwd 解析为绝对路径，再统一分隔符并消解 `.`/`..` 与重复斜杠；模型对同一文件混用绝对与工作区相对拼写，规范化是它只占一条的原因。接受集由 dock 适配器持有而非面板：新请求会在时间线上追加轮次而不卸载 dock，若面板在无待处理时返回 null，接受集会在下次挂载时丢失，因此把集合放在适配器上使先前的接受跨每次渲染保持。

打开能力来自注册时注入的 `SessionChangesInjected`：`cwd` 取自 `sessions.list` 的会话工作区根，`openFile` 只把行内已规范化的绝对路径转给 `remote.session.openWorkspacePath`。行内文本经 `displayPath(path, cwd)` 去掉工作区根前缀——绝对路径是折叠与打开用的身份，相对拼写才是读者在仓库里导航用的写法；工作区外的文件没有更短的命名方式，保留绝对路径。插件不拥有 durable 状态、不发出 cordis 事件，卸载随插件 fiber（HMR 安全）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当变更文件列表不够时阅读这些页面。

- [ui-deliverables](../ui-deliverables/README.zh.md) — 累积 `deliverables` 词汇的相邻包。
- [ui-conversation](../ui-conversation/README.zh.md) — 声明 `conversation.input.dock` 槽位并拥有 composer。
- [ui-session](../ui-session/README.zh.md) — 提供 `useConversation` 会话标准 seat。
- [客户端包地图](../README.zh.md) — 相邻的浏览器 UI 包。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些限制定义了当前的变更文件界面。它们是当前包约束，不是任务待办。

- **无拒绝/回滚** — 接受只是表面清除；不存在逐调用的先前内容快照可用于回滚，因此「拒绝」被有意排除在范围之外。
- **仅列出已声明产物** — 只显示 `ui-deliverables` 累积的写入/编辑产物；模型以其他方式产生的文件不会被列出。
- **首次出现折叠** — 同一文件在会话内只保留一条，展示最早的操作类型；后续编辑不新增条目。规范化只统一拼写（相对/绝对、分隔符、`.`/`..`），不解析符号链接，因此指向同一文件的两条不同符号链接路径仍会各占一行。
- **无跨会话持久化** — 接受集随插件卸载清空；重新加载会话后列表按时间线重建。
- **打开能力由宿主决定** — 行内按钮不预检 `canOpenWorkspacePath`；宿主无法打开时点击会返回失败原因，而不是按钮缺席。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
