---
description: "面向客户端与维护者的会话文件修订说明，用于理解会话内文件基线的捕获方式、撤销的语义边界与冲突处理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-file-revisions

## 概述

`dsh-session-file-revisions` 记录一次会话对每个文件做了什么：文件在会话首次改动**之前**的内容（基线），以及会话最后一次改动**之后**的内容（末态）。这一对边界既是「查看变更」要显示的累积差异，也是「撤销」要移除的部分。

它挂在既有的 `tools/post-execute` waterfall 上读取 `write` / `edit` 的结果——那些结果本身就携带改动前后的全文——因此本包不需要修改 `dsh-tool-fs` 的任何代码，也从不自己读文件。

它与 `dsh-file-changes` 的 `changedFiles` 投影互补而不重复：后者回答「哪些文件被改过」以及每次改动的 seq，前者回答「改了什么内容」。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当某个界面必须展示一次会话对文件做了什么、或必须能把这次会话的改动撤掉时，在工具运行时与会话存储旁挂载本插件。

### 组合

```yaml
- name: '@deepseek-ai/dsh-tools'
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-file-revisions'
```

### 值含义

`list(sessionId)` 返回 `FileRevision[]`，按首次改动顺序排列：

| 字段 | 含义 |
|---|---|
| `path` | 规范化后的绝对路径 |
| `baseline` | 会话首次改动前的内容；`null` 表示文件原先不存在或未捕获到 |
| `origin` | 首次改动时路径的状态：`existing` / `absent` / `unknown` |
| `endState` | 会话最后一次改动后的内容 |
| `operation` | 首次改动的操作类型 |
| `firstOrder` / `lastOrder` | 首次与最后一次改动的位置 |

`origin` 为 `absent` 时，撤销的语义是删除文件而非写回内容。`origin` 为 `unknown` 表示本次会话覆写了一个原先存在的文件，却没有捕获到它的原始内容——存储后端对达到自身展示上限的覆写只报 `before: null`，与真正的「新建」在工具结果里完全同形，区别仅在 `write` 自报的 `operation`。`baseline` 为 `null` 绝不等于「文件原先不存在」，把两者混为一谈会让撤销删掉本次会话从未创建的文件。

### 累积差异的定义

累积差异是**基线 → 末态**，而不是「基线 → 磁盘当前内容」。后者会把会话之外的改动（用户的编辑、其它会话的改动）算进本次会话，也会在撤销时把它们一起抹掉。

### 子代理归属

子代理是独立的 Session，各有自己的事件日志。本包沿 `SessionHeader.parentSession` 把子会话的改动计入根会话视图，因此一次委托产生的改动在根会话里可见、也可撤销。

父子同改一个路径时，基线取更早者、末态取更晚者。判断早晚用的是 `firstOrder`/`lastOrder` 而不是裸 seq：子会话从父日志 fork 出来，自身的 seq 从继承长度起算，与父会话的 seq 属于两套互不可比的编号。同一会话内仍以 seq 为准（它才是让折叠与结果到达顺序无关的依据），跨会话则用结算时刻。

## 失败与恢复

本包只记录，不改变任何工具行为。失败的调用不贡献记录；不含完整 `before` / `after` 的结果无法界定一次撤销，因此被忽略。修改工具的失败不影响已经写下的记录。

记录是**持久的**，落在 storage domain `session_file_revisions`（`per-record`，每个会话一份文档，由 `dsh-storage-domain` 路由）。这一点不是优化：会话日志里的 `tool/result` 只保存渲染文本与该工具自己的展示元数据，`before`/`after` 全文并不在其中，所以修订无法从日志重放——而「修改的文件」列表可以。持久化正是让同一会话的两种视图在重启后仍然一致的机制。写入失败只记一条 warning，不阻断工具调用：修订是能力增强，不是调用能否成立的前提。

恢复出来的记录绑定会话身份（`createdAt`、`cwd` 与 `parentSession`）。会话 id 是一个槽位而不是一次生命周期，因此被删除后以同一 id 重建的会话读不到上一次生命周期的基线——否则由它推导出的撤销会写回当前会话从未有过的内容。`parentSession` 需要存下来，是因为重启后活的会话存储只认识本进程打开过的会话，子代理的父链接否则无处可查，它的改动会从根会话列表里消失。

单会话记录有一个字节上限（`maxRecordBytes`，默认 4 MiB）。超过上限时该记录**不写入**，会话在本次进程内仍可查看与撤销；不做截断，因为被截断的基线会让撤销写出会话从未产生过的内容。

卸载插件即移除服务，已记录的修订随之释放。撤销成功后对应路径的记录会被移除（见 [api-session-file-revisions](../../api/session-file-revisions/README.zh.md)）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释折叠与撤销本身；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 只留首与末

每个 path 只保留第一次的 `before` 与最后一次的 `after`。中间的 `after` 在下一次调用落地时即被取代，而第二次的 `before` 已经是本会话自己的产物，不是会话开始时的状态——所以只有首末两端能界定「会话做了什么」。

两个边界都按位置折叠而非按到达顺序，因此重放、恢复与增量追加三种驱动方式得到同一份记录。

### 撤销是反向 patch

撤销把「末态 → 基线」的差异反向应用到**磁盘当前内容**上，而不是直接写回基线。这正是保留外部改动的原因。

差异按 hunk 逐个应用：整文件应用会在任一 hunk 的上下文不再匹配时拒绝整个文件，于是一处无关的旁人改动会挡住同一文件里所有其它 hunk。逐 hunk 应用则还原仍能匹配的部分并报告其余。

同一行被会话与外部同时改动时无法无歧义地还原，该 hunk 被跳过并报告为冲突，文件保持原样——绝不猜测写入。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [file-changes](../../fs/file-changes/README.zh.md) —— 回答「哪些文件被改过」的相邻投影。
- [api-session-file-revisions](../../api/session-file-revisions/README.zh.md) —— 参考消费者：把本包能力暴露给浏览器的 Remote 命名空间。
- [ui-session-changes](../../client/ui-session-changes/README.zh.md) —— 界面侧消费者：「修改的文件」dock。

-----

<a id="model-experience"></a>
## 模型体验

None, as this package reads already-logged tool results and folds them into a client-facing read model; it registers no prompt, schema, or result of its own.

#### KV Cache effect

This package produces no text that enters a request, so it cannot invalidate an existing reusable prefix.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了当前包。它们是当前包约束，不是任务待办。

- **只认第一方变更工具** —— 仅 `write`、`edit` 与 `str_replace_editor` 的结果计入。模型通过 `bash` 或脚本改动的文件不会被记录。
- **不解析符号链接** —— `path` 按拼写规范化，不解析文件系统身份，因此指向同一文件的两条不同符号链接路径仍各占一条。
- **大文件保留可撤销性** —— 超过显示上限的内容不下发到浏览器（由 Remote 层判定），但基线仍完整保存，撤销照常工作。
- **不比对内容** —— 一次写回完全相同内容的成功调用仍算一次改动并推进 `lastOrder`。
- **超过记录上限的会话丢失持久化** —— 单会话记录超过 `maxRecordBytes` 时不落盘，该会话的改动只在本次进程内可查看与撤销；上限内不做截断。
- **子代理归属依赖存下的父链接** —— 记录里没有 `parentSession` 的会话按根处理，因此手工构造或来自更早版本的记录不会把子会话的改动并入父会话。
