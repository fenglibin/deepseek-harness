# 让会话里的文件链接在 Web 端只读查看

## 为什么

会话页面展示的编辑/新增文件链接，点击后调用 Host 桌面打开器（`session.openWorkspacePath`）。这个行为在两种场景下失效：云端部署时 Host 没有桌面环境（打开器失败），或它在服务器上打开了文件而用户在自己浏览器里看不到；移动端访问时用户手上的设备根本没有那个文件。

已经合入的文件浏览器（`packages/api/file-browser` + `packages/client/ui-file-browser`）具备工作区受限读取与 shiki 语法高亮的全部能力，但入口只有工作区行菜单且只携带 `workspaceId`，无法表达「打开这个具体文件、只读」。

## 改什么

1. `packages/client/ui-file-browser` 的打开意图扩为判别联合：既有工作区臂保持不变，新增文件臂（携带 `path` 与 `readOnly: true`）。
2. 新增 `ctx.fileViewer` 门面服务，`open({ sessionId, path })` 完成会话到工作区的反查并推送打开请求。
3. 对话框在文件臂下以只读态渲染内容区，并新增「用本地编辑器打开」次要入口（受 loopback 与 Host 能力双重门控）。
4. `ui-chat`、`ui-session-changes`、`ui-delivery` 的文件打开改走门面；`ui-deliverables` 的产物行与 `chatFileMentions` 亦改走门面，其目录路径继续走 native。
5. 会话反查不到工作区时明确提示，不静默回退 native 打开。

## 影响

- 改动 `packages/client/ui-file-browser`（判别联合、门面、只读接线、native 次要入口、locale、README）。
- 改动 `packages/client/ui-chat`、`ui-session-changes`、`ui-delivery`、`ui-deliverables`（openFile 改走门面）。
- 不新增包，不改 `packages/api/file-browser` 的 Remote 协议，不改会话日志，不注册提示词或工具——模型不可见。

## 用户可见的取舍

- 超过 `maxFileBytes`（默认 2 MiB）的文件给出明确提示而不是部分内容；此时仍可用本地编辑器入口打开。分页拉取会让 `CodeEditor` 改造成窗口化渲染，代价超过收益，故不做。
- 只读查看器提供语法高亮与复制，不提供编辑：会话链接的语义就是查看。
