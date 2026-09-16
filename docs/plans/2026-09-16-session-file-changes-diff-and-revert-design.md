# 会话文件变更：网页内查看变更与撤销

## 背景与目标

会话页面上「修改的文件」dock 目前只能列出文件路径与操作类型，点击后走 Host 桌面打开器。用户要的是**在网页里直接看到这个文件在本次会话中改了什么**，并且**能把这次会话的改动撤掉**。

目标效果与 git 查看变更一致：

- 文件列表每个条目右侧有「查看变更」，展示该文件在**本次会话**中的累积 diff。
- dock 头部有「查看变更」，展示全部文件的累积 diff。
- 有「撤销」：把该会话改过的文件还原到**会话启始状态**。

## 现状：已有的两层

### 宿主侧 `packages/fs/file-changes`

一个会话投影单元，key 为 `changedFiles`，折叠**完整的持久会话日志**（而非客户端加载的那一页）。`fold.ts` 的 `stepFileChanges` 是纯函数：`tool/call` 命中变更词汇挂 `pending`，成功的 `tool/result` 落到 `files`，`turn/end` 丢弃被打断的调用残留。

产物 `FileChangeEntry` 只有四个字段：`path`、`operation`、`firstSeq`、`lastSeq`——**不含任何内容**。

### 客户端侧 `packages/client/ui-session-changes`

注册在 `conversation.input.dock` 插槽（`order: -10`）。`SessionChangesDock` 用 `useProjection('changedFiles')` 读投影；无投影注册表时回退到 `sessionChanges(conversation, cwd)` 窗口折叠。「接受」把 path 的 `lastSeq` 写进会话作用域的持久化 store，**不动磁盘**。

### 缺口

1. **`FileChangeEntry` 没有内容**，产不出 diff。
2. **没有会话启始态锚点**。`before` 只是单次调用前的内容，不是会话开始前的内容；文件改 5 次就有 5 个 `before`。
3. 没有网页内的 diff 展示与撤销通道。

## 关键发现：内容已经在盘上，且可零侵入取得

`packages/fs/tool-fs/src/write.ts` 与 `edit.ts` 的 `execute` 里，`outcome.before` / `outcome.after` 是**全文**（LF 归一化的 diff 基）。它们目前只被 `presentationMeta` 转成 hunks 塞进 `tool/result` 的 `meta`，而 `meta` 是有损的（`computeHunkDiffs` 刻意丢掉上下文行）。

取得它们的钩子已经存在且公开：`packages/core/tools/src/index.ts:167` 的 `tools/post-execute` waterfall。其 `exec.agent.session` 就是 Session 对象本身（现有 `fs-observation-policy` 已靠 `actor.agent.session` 定位会话），`ToolExecutionSuccess.value` 携带 `{path, operation, before, after}`。

**结论：不需要修改 `dsh-tool-fs` 一行代码。**

## 技术决策

### D1 语义边界：只统计本会话，子代理沿 parentSession 聚合

「当前会话」的边界是 Session。子代理是**独立 Session**（`SessionHeader.parentSession` 记录父会话），各有自己的事件日志，因此并行任务天然不会互相污染。

按用户选择，视图**聚合本会话及其子孙子代理**：沿 `header.parentSession` 上溯到根，把整棵子树的变更合并进根会话视图，撤销时也一并还原。

### D2 累积 diff 是「会话启始态 → 会话末态」，不是「启始态 → 当前磁盘」

这是本设计最关键的一条。若取当前磁盘内容，用户在别处（或其它会话）对该文件的改动会被算进本次会话的 diff，也会被撤销一起抹掉。

正确语义：

- **累积 diff** = 会话启始态 → **会话最后一次修改后的预期内容**（会话末态）。
- **撤销** = 把会话的改动从**当前磁盘内容**里减掉，保留其它来源的改动。

对每个 path 存储：

| 字段 | 含义 |
|---|---|
| `baseline` | 该 path 在本会话（含子树）**第一次**变更时的 `before`；`before === null` 记为「原先不存在」 |
| `sessionEnd` | 最后一次 `after`（LF 归一化基） |

**不存中间的 `after`**——那是重复且会立刻过期的数据。

### D3 撤销用反向 patch，逐 hunk 应用且冲突安全

撤销是把会话改动从当前磁盘内容里减去，即三路合并的逆向操作。用 jsdiff v9（仓库已有依赖 `diff@^9.0.0`）的 `createTwoFilesPatch` + `reversePatch` + `applyPatch`。

实测结论（jsdiff v9，`fuzzFactor: 1`）：

| 场景 | 结果 |
|---|---|
| agent 改 line2，用户改 line5 | 还原 line2，保留 `LINE5-USER` |
| agent 改三处，用户改第四处 | 逐 hunk 应用：成功的还原、冲突的跳过 |
| agent 与用户改同一处 | `applyPatch` 返回 `false`，**整体拒绝，不半改文件** |
| 多 hunk 中一个冲突 | 整文件返回 `false`；按 hunk 逐个重试则局部成功 |

由此得出两条规则：

- **逐 hunk 应用**，单个 hunk 冲突只跳过该 hunk，不牵连同文件其它 hunk。
- **真冲突（同一处被改）报失败**，绝不静默写入——`applyPatch` 返回 `false` 即放弃该文件，磁盘保持原样。
- **全部撤销按文件逐个应用，失败汇总**（用户选择），成功的生效，失败的在 UI 上列出原因。

### D4 大文件降级为「不预览但可撤销」

`before` 在超过 `diffBasisMaxBytes` 时为 `null`（fs-local 行为）。此时该文件的 diff **不用于渲染**（UI 显示「文件过大，无法预览」），但**基线仍完整保存，撤销照常工作**。

### D5 「接受」与「撤销」是两种不同操作，并存

- **接受**（现有行为不变）：我认可了，从待处理列表移走；纯 UI dismissal，不动磁盘。
- **撤销**（新增）：真还原文件。

UI 上明确分开。

### D6 三个新包，主工程零改动

| 包 | 职责 |
|---|---|
| `packages/fs/session-file-revisions` | 宿主核心：监听 `tools/post-execute` 捕获基线/末态，子代理聚合，暴露 `get`/`undo` |
| `packages/api/session-file-revisions` | Typert Remote 命名空间：`list` / `diff` / `undo` |
| `packages/client/ui-session-changes`（扩展） | dock 每行加「查看变更」，头部加「撤销」；复用 `DiffBlock` 原语 |

`packages/api/session-file-revisions` 照抄 `dsh-api-file-browser` 的范本：`TypertRemoteService` + `@Remote()` 装饰器 + `RemoteErrorDetailsMap` 声明合并。

客户端复用 `packages/client/ui-primitives` 的 `DiffBlock`（`DiffHunk {path, oldText, newText}`），不写新渲染。

装配只需在 `packages/bundle/web-app/cordis.patch.yml` 加对应行。`dsh-tool-fs`、`file-changes`、`ui-session-changes` 现有代码一行不改。

## 注意事项

1. **LF 归一化一致性**：`before/after` 是归一化文本，与磁盘原始内容可能差 CRLF。撤销回写必须保持同一基，否则引入假 diff。
2. **基线字节上限**：需配置化；超限不存渲染用 diff，但基线必须存（D4）。
3. **并发**：子代理并行改同一文件时，末态以 seq 最大者为准。
4. **撤销后的基线**：撤销成功应清除或推进该 path 的基线，否则二次撤销会把已还原内容再「反」一次。
5. **新建文件的撤销**：`baseline === null` 时撤销语义是删除文件；若用户之后又写入了内容，降级为「非空则保留并报告」，不直接删。

## 交付物

- 三个包的实现与单测（纯函数折叠、反向 patch 冲突矩阵）。
- 按 `packages/AGENTS.md` 要求：非平凡插件需 REAL-composition 测试（经 Loader 启动测试用 `cordis.yml`）。
- 无密钥录制会话快照（变更用户可见输出）。
- 包名、README、JSDoc 契约随行为同步更新。
