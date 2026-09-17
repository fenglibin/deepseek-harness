# Agent Note: 会话文件修订的持久化与错误归因

Status: implemented

## Problem

「修改的文件」dock 的「查看变更」在真实使用里报「撤销失败：this session recorded no change for path: …」。这条消息同时暴露了三个缺陷。

**归因错误。** `RevisionDiffPanel` 拉取 diff 失败时复用了 `revertFailed`，而该面板只调 `diff`、从不撤销——它把一件没发生的事报给了读者。

**诊断不可读。** 客户端把远端错误折叠成 `new Error(result.error.message)` 后直接展示，于是失败码连同英文原文一起摊给读者。错误码本来就在 `RemoteFailure` 上，只是被丢掉了。

**数据源不一致（根因）。** dock 的列表读宿主 `changedFiles` 投影，它折叠完整持久日志、重启可重建；而查看与撤销读 `SessionFileRevisions` 的内存 store，它挂在 `tools/post-execute` 上捕获、完全不持久化。两者的时间窗不同，于是列表里能显示的文件，重启后每一条都点不开。

这个缺陷不能在日志侧修：`tool/result` 只保存渲染文本与工具自己的展示元数据（`packages/core/agent-loop/src/tool-calls.ts`），修订捕获所需的 `before`/`after` 全文并不在日志里。修订无法重放，而列表可以——这正是它必须自己持久化的原因。

## Decision

### 修订记录持久化到 `session_file_revisions` 域

新增 storage domain（`per-record`，表 `sessions` 以 `SessionId` 为键），把每个会话自己的修订写下来。选择侧车存储而不是复用投影缓存，是因为投影缓存契约明确写着它是 fold shortcut、never an authority、行可能陈旧；修订恰恰不能被当作可丢弃的缓存——丢弃它意味着一次能力丢失，而不是一次更长的重放。

`per-record` 让版本升级只丢弃陈旧的会话文档，而不是整个介质：一份读不出的文档不该带走其它会话的修订。

记录绑定会话身份（`createdAt`、`cwd`、`parentSession`）。会话 id 是槽位而非生命周期，被删除后重建的同名会话若继承旧基线，由它推导出的撤销会写回当前会话从未有过的内容。`parentSession` 存下来是因为重启后活的会话存储只认识本进程打开过的会话，子代理的父链接否则无处可查。

### 写入在发起处等待，而不是留给 teardown

实现过程中被一个测试抓住的真实缺陷：`KvTable.delete` 从域的内存状态判定，键看起来不存在就跳过介质写入。因此一个在 `put` 仍在排队时发出的 `delete` 什么也不做，而排队的 `put` 随后会把该 delete 想删掉的记录落盘。查询侧的 `delete` 又是 `DomainError: closed`——teardown 读一次链尾就关闭域，晚加入的任务会被正在关闭的介质拒绝，于是记录静默丢失。

两条修法同时采纳：同一会话的写入串到该会话自己的链上（后一个任务观察前一个的结果），并且写入在**发起处**被 await（捕获监听器、`forget`、`dropPath` 都是异步的）。teardown 的排空只作安全网。这正是「一个异步操作用一个生命周期控制器表示」的形态——写入的所有权而不是每个调用点各自处理时序。

### 列表按行判定能力

客户端改读宿主已有的 `list` 动词（此前无消费者），用它的 `entries` 决定每一行是否提供查看与撤销，条带的「全部撤销」也按同一事实判定。列表与修订记录读的是同一份权威事实，于是「点开必然报错的行」在界面上消失。`list` 只返回摘要（path/operation/origin/行数/oversized），首屏不搬运文件内容。

记录集合在变更列表**增长**时重读，而不是只在挂载时读一次。dock 在会话进行中始终保持挂载，agent 每次改动都由宿主记录一条；只在挂载时读会让刚被改动的文件在页面刷新前一直没有控件——而「读者正看着 agent 工作」恰恰是常态。依赖取变更条数而非列表引用，因为投影每次会话变动都会重建数组。

### 失败按错误码分派

客户端保留 `code`，由面板按码选文案：`session-revisions/unknown-path` 与 `session-revisions/no-workspace` 各得一句可读说明，其它码保留宿主原始诊断。仓库已有保留码的先例（`packages/client/ui-settings-skills/src/client/index.ts`）。归因也修正了：该面板有自己的 `diffFailed`，`revertFailed` 留给 dock 的撤销路径。

### 撤销成功后清理记录

`revert` 此前从不调用 `forget`。内存态下这只是让已撤销的行留在列表；持久化后同一条记录会跨重启存活，读者会反复看到一个已无改动的文件。规则抽成 `retiresRevision(status)`：只有 `reverted` 退休记录，`conflict`/`missing` 保留（文件上仍有本会话的改动待处理），`unchanged` 保留（撤销并未发生，记录仍是描述现状的唯一依据）。

### `str_replace_editor` 的结果值携带改动事实

该工具的结果值此前是纯字符串，捕获看不到前后内容——而 `mutation.ts` 已经把它算作变更，于是列表显示、却永远不可操作。改为对象并用 `oneOf` 区分两类：改动类（`create`/`str_replace`/`insert`）携带 `path`/`before`/`after`/`operation`，只读类（`view`）只携带 `path`/`text`。

`render` 返回该值自己的 `text`，因此模型看到的句子逐字不变，`tests/tools.spec.ts` 的 16 个渲染断言无需改动——这也是选这条形状而非给文本加后缀的原因。

修改操作报告的是**工具自己读到的** `before`，不是后端的缓冲基准：`str_replace` 与 `insert` 本就必须读取内容来定位字面量，因此这个 `before` 总是完整的，即使后端为超大覆写拒绝缓冲。

## Alternatives considered

- **从会话日志重放修订。** 不可行：`tool/result` 不携带 `before`/`after`。
- **复用投影缓存承载修订。** 契约冲突：投影行是可能陈旧的 fold shortcut，而修订丢失是能力丢失。
- **超限记录截断后写入。** 被截断的基线会让撤销写出会话从未产生过的内容，比不持久化更糟；因此超限时删除记录并记 warning。
- **在结果文本里附带内容。** 会改变模型可见输出并波及录制快照；结构化值把内容留给捕获层，模型可见面零变化。

## Consequences

收益：查看与撤销在进程重启后仍然可用，列表不再出现点开必然报错的行；失败按读者处境归因；`str_replace_editor` 的改动与 `write`/`edit` 一样可查看、可撤销，列表与可操作性重新对齐。

代价：新增一个磁盘域，单会话记录同时保存每个改动文件的两个全文版本，因此磁盘占用随会话自身的工作量增长——字节上限是硬约束，超限的会话退回「只在本次进程内可用」。撤销会改变 `list` 的输出（退休该路径），当前 `list` 只有按行能力一个消费者。`str_replace_editor` 的结果值形状进入 PTC 模式的 SDK 文本，属于 public API 变更；工具 schema 快照只记 `name`/`description`/`parameters`，因此录制快照未受影响。

## Related

同一 dock 的相邻决策各有归属，本 Note 不重复它们：「修改的文件」列表的来源与 seq 折叠归 [全会话投影](../feature/2026-09-14-session-changed-files-whole-log.zh.md)，接受记录与两个视图归 [接受记录改为会话级 store](../feature/2026-09-17-session-changes-accept-store-and-views.zh.md)，路径拼写归 [dock 路径](../feature/2026-09-08-session-changes-dock-paths.zh.md)。查看变更与撤销此前没有 Note——本 Note 是它的第一个归属者，因此没有需要归档的被取代记录。

## Testing

- `packages/fs/session-file-revisions`：50 个测试，含「进程被替换后仍能读到修订」「同名会话重建后旧记录不生效」「重建的子会话记录不并入根会话」「超限不写入」「撤销后跨重启不再提供该路径」，以及编辑器改动经真实 `tools/post-execute` 被捕获、只读调用不产生记录。
- `packages/api/session-file-revisions`：13 个测试，含 `retiresRevision` 的四种状态。
- `packages/client/ui-session-changes`：76 个测试，含按行能力、三种错误码文案，以及「失败的 diff 不得呈现为失败的撤销」。
- `packages/fs/tool-str-replace-editor`：16 个测试原样通过，证明渲染文本逐字未变。
- `packages/core/tools`（含 PTC 的 91 个）与全部 bundle 测试通过，证明 output schema 变更未破坏 SDK 投影。
- `tsc -b` 三个宿主包与客户端包类型检查通过；`verify-cordis-config` 159 个配置通过。
