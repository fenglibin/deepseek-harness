# 在网页内查看会话文件变更并支持撤销

## 为什么

「修改的文件」dock 只列出路径与操作类型（`FileChangeEntry` 仅有 `path`、`operation`、`firstSeq`、`lastSeq`），不含任何内容，因此无法展示 diff；点击文件走的是 Host 桌面打开器，云端部署与移动端访问都不可用。用户要的是与 git 一致的体验：在网页里看到**该文件在本次会话中改了什么**，并能把这次会话的改动撤掉。

内容其实已经产生并可零侵入取得：`write` / `edit` 返回的 `before` / `after` 是全文，而 `packages/core/tools/src/index.ts:167` 的 `tools/post-execute` waterfall 的 `exec.agent.session` 就是 Session 对象、`value` 携带该全文。因此无需修改 `dsh-tool-fs`。

## 改什么

1. 新增宿主包 `packages/fs/session-file-revisions`：监听 `tools/post-execute` 捕获每个 path 的**会话基线**（本会话第一次变更时的 `before`，`null` 表示原先不存在）与**会话末态**（最后一次 `after`）；沿 `SessionHeader.parentSession` 把子孙子代理的变更聚合到根会话视图。
2. 累积 diff 定义为**会话启始态 → 会话末态**，而非 → 当前磁盘内容；后者会把外部或其它会话的改动算进本次会话。
3. 撤销用 jsdiff 反向 patch，从**当前磁盘内容**里减掉会话改动，保留外部改动；逐 hunk 应用，真冲突整文件拒绝且不半改文件；全部撤销按文件逐个应用、失败汇总。
4. 新增 Remote 命名空间 `packages/api/session-file-revisions`（`list` / `diff` / `undo`）。
5. 扩展 `packages/client/ui-session-changes`：dock 每行加「查看变更」，头部加「查看变更」与「撤销」，复用既有 `DiffBlock` 原语。
6. 「接受」与「撤销」并存：接受是界面层面的隐藏，不动磁盘；撤销是真还原。

## 影响

- 新增两个包，扩展一个客户端包；装配改动限于 `packages/bundle/web-app/cordis.patch.yml`。
- `dsh-tool-fs`、`dsh-file-changes` 现有代码不改。
- 大文件（超过 diffBasisMaxBytes）降级为不预览但仍可撤销。
