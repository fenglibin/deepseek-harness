# 会话文件修订的持久化与错误归因

## 为什么

「修改的文件」dock 的「查看变更」在真实使用中失败时报「撤销失败：this session recorded no change for path: …」，暴露三个问题。

其一，归因错误：`RevisionDiffPanel` 拉取 diff 失败时复用了撤销的文案（`packages/client/ui-session-changes/src/client/RevisionDiffPanel.tsx:104` 用 `revertFailed`），而该面板从不执行撤销。

其二，诊断不可读：客户端把远端错误折叠成 `new Error(result.error.message)`（`packages/client/ui-session-changes/src/client/index.ts:83`）后直接展示，失败码 `session-revisions/unknown-path` 连同英文原文一起摊给读者。

其三，也是根因：dock 的列表读宿主 `changedFiles` 投影，它折叠**完整持久日志**、重启可重建；而「查看变更／撤销」读 `SessionFileRevisions` 的**纯内存 store**，它挂在 `tools/post-execute` 上捕获，完全不持久化。两者的时间窗不同，于是列表里能显示的文件，重启后每一条都点不开。

修法不能在日志侧：`tool/result` 只保存渲染文本与可选 `meta`（`packages/core/agent-loop/src/tool-calls.ts:313`），修订捕获所需的 `before`/`after` 全文并不在日志里，因此无法重放，必须自己持久化。

## 改什么

1. `packages/fs/session-file-revisions` 新增 storage domain（`session_file_revisions`，`per-record`，表 `sessions` 以 `SessionId` 为键），把每个会话的修订记录持久化；记录绑定 `createdAt`/`cwd` 身份，身份不符即丢弃。
2. 客户端改读宿主已有但当前无消费者的 `list` 动词，按行判定能力：没有修订记录的文件行不提供「查看变更」「撤销」，列表里不再出现点开必然报错的行。
3. `RevisionDiffPanel` 使用自己的失败文案，并按远端错误码分派可读说明。
4. `revert` 后按状态清理记录（`reverted` 删除，`conflict`/`missing`/`unchanged` 保留），避免持久化后已撤销的文件反复出现。
5. `packages/fs/tool-str-replace-editor` 的 output schema 由纯字符串改为对象，用 `oneOf` 区分改动类与只读类，使该工具的改动同样可被捕获；`render` 保持返回逐字相同的文本。

## 影响

- 改动四个包：`fs/session-file-revisions`（持久化 + 捕获范围）、`api/session-file-revisions`（撤销后清理）、`client/ui-session-changes`（文案 + 按行能力 + 错误码分派）、`fs/tool-str-replace-editor`（output 契约）。
- 撤销的语义与安全边界不变：反向 patch、逐 hunk、realpath 包含检查、写盘原子性均保持。
- 会话日志格式与录制快照不变；`tool/result` 契约不动。
- `str_replace_editor` 的 output 变更会投影进 PTC 模式的 SDK 文本（`packages/core/tools/src/index.ts:881`、`:1230`），属 public API 变更，需在同一变更内更新相关期望。
