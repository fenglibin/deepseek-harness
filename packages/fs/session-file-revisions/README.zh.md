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
| `origin` | 首次改动时路径的状态：`existing` / `absent` / `unknown` / `deleted` |
| `endState` | 会话最后一次改动后的内容；`deleted` 时为空 |
| `operation` | 首次改动的操作类型：`write` / `edit` / `delete` |
| `firstOrder` / `lastOrder` | 首次与最后一次改动的位置 |

`origin` 为 `absent` 时，撤销的语义是删除文件而非写回内容。`origin` 为 `unknown` 表示本次会话覆写了一个原先存在的文件，却没有捕获到它的原始内容——存储后端对达到自身展示上限的覆写只报 `before: null`，与真正的「新建」在工具结果里完全同形，区别仅在 `write` 自报的 `operation`。`baseline` 为 `null` 绝不等于「文件原先不存在」，把两者混为一谈会让撤销删掉本次会话从未创建的文件。

### 被删除的文件

一次 shell 调用删掉的文件不会被任何写工具的结果携带，因此它的内容在本包任何地方都读不到——发现删除时文件已经不在磁盘上了。本包记录这一事实（`origin: 'deleted'`，`operation: 'delete'`），内容侧留空；恢复由消费者从工作区的 git 对象取得。

识别不解析 shell 命令文本。bash 是任意代码——`find . -delete`、`for` 循环、`python -c "os.remove(...)"`、`git clean -fd` 都无法用命令文本穷尽，而漏认与错认都会让读者看到一个错误的列表。本包改为查询工作区的 git 状态：它是**结果**而非**意图**，因此覆盖脚本与间接删除，也与删除是怎么发生的无关。

`DeletionBaseline` 按会话记录归属：git 报告的是工作区当前全部删除，不区分是否本会话所为，所以在会话内**第一条可能删除文件的命令执行之前**记一份基线，之后只报告相对该基线的增量。基线必须在命令执行前建立——折进基线会让那条命令自己的删除永远不被报告。基线只建立一次，后续扫描不会把它推后。

git 不可用（工作区不是仓库、命令失败）一律当作「没有删除」而非错误：该能力是列表的增强，缺少它时其余捕获路径照常工作。`observeDeletions` 可以关掉这一能力。

**路径拼写**：git 报告的删除路径相对于**仓库根**，而修订记录按会话工作区的绝对路径索引，两者只在工作区就是仓库根时相同。因此扫描会先用 `rev-parse --show-toplevel` 取到仓库根再解析，并只保留工作区之内的路径；工作区是仓库子目录时，工作区之外的删除不属于这次会话的列表。解析以工作区的拼写为基准重新拼出结果，因为修订记录与写工具走同一套规范化——若返回符号链接解析后的真实路径，同一个文件会因拼写不同占两条记录。

同一路径先写后删时，删除**取代**原先的记录而不是折进它：写记录持有可用于反向 patch 的两侧内容，而被删路径在磁盘上已无可 patch 之物。删除后再写则记为 `unknown`——写回的内容所取代的是已删除状态，那个状态在任何地方都不存在了，因此该记录诚实地承认没有基线。

### 删除的恢复靠 git 的仓库相对路径

恢复时 git 的 `HEAD:<path>` 与 `:<path>` 都要求**仓库相对**路径。工作区是仓库子目录时，工作区相对路径与仓库相对路径不同，直接用前者去问会得到 `path exists, but not ...` 并让该工作区里的每一次恢复都失败；因此恢复先用 `rev-parse --show-prefix` 取到工作区在仓库中的前缀再拼接。git 进程在解析过符号链接的工作区根上运行（macOS 的 `/tmp` 是 `/private/tmp`），而工作区相对的余下部分按调用方的拼写相减——被删文件没有可解析的真实路径，混用两种拼写会减掉两个无关的前缀。

### 累积差异的定义

累积差异是**基线 → 末态**，而不是「基线 → 磁盘当前内容」。后者会把会话之外的改动（用户的编辑、其它会话的改动）算进本次会话，也会在撤销时把它们一起抹掉。

### 行数

`lineCounts(revision)` 报告一次变更真正新增与删除的行数，由 `diffLines` 按行比较得出。它描述的是**变更**而非两侧文件：单行被改写的文件报告新增一行、删除一行，与文件总长无关。无基线可比（`unknown`）与被删除的路径两侧均为 0，因为两个计数都不可推导。

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

### 删除与反向 patch 是两条路

反向 patch 只适用于本会话改动过的**现存**文件：它需要两侧内容才能构造差异。被删除的路径没有可 patch 之物，它的恢复走的是另一条路——从工作区的 git 对象取回内容，因此本包只记录「它被删了」这一事实，不持有它的内容。这两条路在 `revertOne` 中按 `origin` 分派，互不重叠。

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

- **只认第一方变更工具** —— 仅 `write`、`edit` 与 `str_replace_editor` 的结果携带内容侧。模型通过 `bash` 或脚本改动文件的其它形式不会被记录，**被删除的文件**是唯一的例外，它只记录删除这一事实而不记录内容。
- **删除依赖工作区的 git 状态** —— 只在 git 仓库内识别删除，且只报告「本会话期间变为已删除」的路径；工作区不是仓库时改为 `observeDeletions: false` 更诚实。
- **不解析符号链接** —— `path` 按拼写规范化，不解析文件系统身份，因此指向同一文件的两条不同符号链接路径仍各占一条。
- **大文件保留可撤销性** —— 超过显示上限的内容不下发到浏览器（由 Remote 层判定），但基线仍完整保存，撤销照常工作。
- **不比对内容** —— 一次写回完全相同内容的成功调用仍算一次改动并推进 `lastOrder`。
- **超过记录上限的会话丢失持久化** —— 单会话记录超过 `maxRecordBytes` 时不落盘，该会话的改动只在本次进程内可查看与撤销；上限内不做截断。
- **子代理归属依赖存下的父链接** —— 记录里没有 `parentSession` 的会话按根处理，因此手工构造或来自更早版本的记录不会把子会话的改动并入父会话。
