---
description: "面向客户端与维护者的全会话变更文件说明，用于选择、组合或排查 changedFiles 投影单元与共享的文件变更词汇。"
kind: "package-reference"
---

# @deepseek-ai/dsh-file-changes

## 概述

`dsh-file-changes` 以 `changedFiles` 投影单元的形式提供一次会话里 agent 究竟改过哪些文件。它折叠的是**完整的持久会话日志**，而不是客户端已加载的那一页，因此客户端分页了多少历史都不改变结果——这正是它存在的理由：客户端只能看到尾部窗口（默认 50 条消息），窗口之外的轮次连边界事件都不在，客户端自己的折叠会把这些改动整个漏掉。同一插件还拥有第一方文件变更的**唯一一份词汇**（哪些工具算变更、路径写在哪个参数、对应的用户可见操作类型），宿主折叠与浏览器端的轮次折叠都读它，因此两者永远不可能对「什么算一次变更」产生分歧。在已挂载投影注册表的组合中选择它；没有注册表的装配不受影响，其消费者回退到自己的窗口折叠。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当某个界面必须显示会话真正的变更文件集合、且会话长度可能超过客户端一次加载的历史时，在会话存储与投影注册表旁挂载此插件。只有存在注册表时单元才会注册。

### 组合

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-file-changes'
```

### 值含义

`changedFiles` 的值是 `{ files: FileChangeEntry[] }`，按首次出现顺序排列，每个文件一条：

| 字段 | 含义 |
|---|---|
| `path` | 规范化后的绝对路径（相对路径已按会话 cwd 解析，分隔符统一，`.`/`..` 与重复斜杠已消解） |
| `operation` | 该路径**最早**一次成功变更的操作类型：`write`（新建/覆盖）或 `edit`（就地修改） |
| `firstSeq` | 该路径最早一次成功变更的 seq；决定列表顺序 |
| `lastSeq` | 该路径**最后**一次成功变更的 seq；读者「接受」时记的就是它 |

同一文件无论被写成绝对路径还是工作区相对路径都只占一条。`lastSeq` 是接受语义的支点：界面记下读者接受时的 `lastSeq`，此后该路径只要出现一次更新的成功变更，`lastSeq` 增大，它就重新成为待处理项。

### 与「每轮产物」的区别

本单元是**会话级**的。每轮收尾的产物芯片行是**轮次级**的，由 `dsh-client-ui-deliverables` 从同一个词汇折叠自己那一轮，两者服务不同界面、互不影响。

### 失败与恢复

没有投影注册表时单元是惰性的：`inject` 使 fiber 保持挂起，不注册任何内容，因此其他装配缺少 `changedFiles` 键——消费者把它读作「能力缺席」并回退到窗口折叠。卸载插件会移除该键，因为注册是挂载 fiber 上的 effect。失败的变更调用不贡献任何条目；被打断的轮次留下的未结算调用在该轮 `turn/end` 时丢弃。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释折叠本身；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 词汇的唯一归属

`mutation.ts` 判定哪些调用算变更：`write` 读 `file_path` 且要求有 `content`，`edit` 读 `file_path` 且要求 `old_string` 非空且与 `new_string` 不同，`str_replace_editor` 读 `path` 且只认 `create`/`str_replace`/`insert` 三种命令。只读命令（`view`）、不受支持的工具、无法解析的 JSON 与不完整的参数都不算变更。`path.ts` 提供规范化。

浏览器端经 `./client` 出口取这两者。这是刻意的单点归属：若客户端另写一份解析，两份必须在「哪些调用算变更」上永远一致，而那正是重复归属会造成的缺陷。

### 有界状态

折叠状态是 `{ cwd, files, pending }`，两个累加器各自受不同约束、都不随日志增长：`files` 每个被改过的不同路径一条，`pending` 只保留尚未拿到结果的变更调用（结果一落地就移除，`turn/end` 丢弃该轮残留）。这是硬要求而非微优化——该状态会被写入投影缓存，按事件增长的累加器会把整份会话日志塞进每个检查点文档，而单个轮次可以横跨整个会话。`cwd` 在 `init(header)` 时从不可变的会话头取一次，因此 `apply` 始终保持纯函数。

### 排序与重放

`changedFilesView` 按 `firstSeq` 排序而不是按对象键的插入顺序，因此全量重放、从检查点恢复与增量追加三种驱动方式得到同一份列表。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md) —— 投影单元约定与驱动语义。
- [session-stats](../../session/session-stats/README.zh.md) —— 同样为「窗口折叠看不见被分页出去的轮次」而建的相邻单元。
- [ui-session-changes](../../client/ui-session-changes/README.zh.md) —— 参考消费者：「修改的文件」dock。
- [ui-deliverables](../../client/ui-deliverables/README.zh.md) —— 复用同一份词汇的轮次级产物行。
- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md) —— 本组各包的共享词汇与错误分类体系。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 changedFiles 单元把已写入日志的工具调用与结果折叠成面向客户端的读模型，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了当前单元。它们是当前包约束，不是任务待办。

- **只认第一方变更工具** —— 仅 `write`、`edit` 与 `str_replace_editor` 的调用计入。模型通过 `bash` 或脚本改动的文件不会被列出；扩展该集合是改 `mutation.ts` 一处，但每个新工具都需要论证其参数形状。
- **不解析符号链接** —— 规范化统一拼写（相对/绝对、分隔符、`.`/`..`），不解析文件系统身份，因此指向同一文件的两条不同符号链接路径仍各占一条。
- **不比对内容** —— 一次成功的 `write` 即使写回完全相同的内容也算新变更，`lastSeq` 随之增大。按内容判定需要宿主侧读取并比较文件，成本与歧义都更高。
- **`operation` 取最早一次** —— 同一文件先写后改仍显示为 `write`；后续变更只推进 `lastSeq`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
