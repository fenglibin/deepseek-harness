---
description: "面向客户端与维护者的 sessionFileRevisions Remote 说明，用于选择或排查变更列表、累积差异与撤销三个方法。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-session-file-revisions

## 概述

`dsh-api-session-file-revisions` 把一次会话的文件修订暴露为 `sessionFileRevisions` Remote 命名空间，共三个方法：`list` 列出改动过的文件，`diff` 读一个文件的累积差异，`revert` 撤销改动。

它是 `@deepseek-ai/dsh-session-file-revisions` 的浏览器入口：后者只做记录，本包负责把记录变成可远程调用的动作，也是唯一真正写盘的一层。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在组合中挂载本包；浏览器侧通过 `ctx.remote.sessionFileRevisions` 调用。客户端装配（`@deepseek-ai/dsh-api-remotes`）必须挂载本包的 `/remote` 贡献，否则浏览器拿不到该命名空间。

### 组合

```yaml
- name: '@deepseek-ai/dsh-typert-protocol'
- name: '@deepseek-ai/dsh-session-file-revisions'
- name: '@deepseek-ai/dsh-api-session-file-revisions'
```

### 方法

| 方法 | 作用 |
|---|---|
| `list` | 该会话（含子代理）改动过的文件，含增删行数、基线来源与是否超限 |
| `diff` | 一个文件的基线与末态；有基线但超限时 `withheld` 为 `oversized` |
| `revert` | 撤销一个路径，或省略 `path` 撤销该会话全部记录 |

### 失败与恢复

`revert` 逐路径独立执行：一处冲突不牵连其余路径，结果按路径逐条返回 `reverted` / `unchanged` / `conflict` / `missing`。完全失败时才以 Remote 错误返回。

撤销成功（`reverted`）的路径会连同它在 `dsh-session-file-revisions` 中的记录一起被移除，因为该路径上已经没有本会话的改动了；继续留着它会让界面反复提供一个无事可做的文件，而在记录持久化之后这种过期提示会跨重启一直存在。`conflict`、`missing` 与 `unchanged` 都保留记录：前两者的文件上仍有本会话的改动待处理，后者表示撤销并未真正发生，记录仍是描述当前状态的唯一依据。

`diff` 与 `revert` 可能以 `session-revisions/unknown-path` 失败（本会话没有该路径的记录）。该错误码是稳定契约的一部分，客户端据此给出可读说明，而不是把英文诊断直接呈现给读者。

## 写盘的安全边界

`revert` 是唯一改动文件的方法，因此每次写盘前都解析该会话自己的工作区根，并经 `realpath` 包含检查后才落盘。这一步不是形式：`path` 来自会话日志，捕获之后放置的符号链接完全可能指向工作区之外。

回写走同目录临时文件加 `rename`，中断不会留下截断文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 撤销读磁盘，不读末态

`revert` 读的是文件的**当前**内容，把「末态 → 基线」的差异反向应用上去，因此会话之外发生的改动留在结果里。若直接用捕获的末态比较，那些改动会被算作会话的产物并一并抹掉。

### 新建文件的撤销

基线为 `null` 且 `origin` 为 `absent` 时，文件由本次会话创建。此时撤销的语义是删除，但仅当文件内容仍是会话写入的那一刻才删；此后由他人写入的内容不属于本次会话，删掉它是数据丢失。

### 基线未捕获的文件

`origin` 为 `unknown` 表示本次会话覆写了文件，但它的原始内容没有被捕获——存储后端对达到自身展示上限的覆写只报 `before: null`。这与「会话新建」在工具结果里完全同形，区别只在于 `write` 自报的 `operation`。

此类文件既无法预览（没有可比对的基线，把它画成整文件新增是在编造改动），也无法撤销（没有基线可还原）：`diff` 以 `withheld: 'baseline-missing'` 说明，`revert` 报告 `conflict`。绝不可按「新建」删除它——文件确实存在过，删除会毁掉本次会话从未产生的内容。

### 冲突即拒绝

反向 patch 无法干净应用时返回 `conflict` 并保留文件原样。部分 hunk 成功时返回 `conflict` 并说明跳过数量——已成功的部分已写入，因为那部分可以无歧义地还原。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [session-file-revisions](../../fs/session-file-revisions/README.zh.md) —— 本 Remote 的记录来源与撤销算法。
- [ui-session-changes](../../client/ui-session-changes/README.zh.md) —— 参考消费者：「修改的文件」dock。
- [file-browser](../file-browser/README.zh.md) —— 同一工作区包含检查思路的另一个消费者。

-----

<a id="model-experience"></a>
## 模型体验

None, as this package exposes already-recorded revisions to the browser; it registers no prompt, schema, or result of its own.

#### KV Cache effect

This package produces no text that enters a request, so it cannot invalidate an existing reusable prefix.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了当前包。它们是当前包约束，不是任务待办。

- **依赖会话的工作区根** —— 会话没有 `cwd` 时 `revert` 报 `session-revisions/no-workspace`；`list` 与 `diff` 不受影响，因为它们不写盘。
- **超限内容不下发** —— 任一侧超过 512KB 时 `diff` 的 `withheld` 为 `oversized`，浏览器无法预览，但该路径仍可撤销。
- **未捕获基线的文件不可撤销** —— `origin` 为 `unknown` 的路径只能报告冲突；见「基线未捕获的文件」。
- **不跨会话合并** —— 每次调用只针对给定会话及其子代理；不提供跨会话聚合。
