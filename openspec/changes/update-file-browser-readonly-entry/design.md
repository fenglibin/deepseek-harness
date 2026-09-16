# 技术决策

### D1 扩展现有文件浏览器，不新建只读查看器包

会话链接需要的内容区正是 `ui-file-browser` 已实现的（文本走 `CodeEditor`、图片走 `<img>`、二进制与超限给提示），差别只在打开意图与是否可写。新增第三个注册点与一个门面服务，而不是第二套 Modal 与第二套 Remote 驱动。

### D2 打开意图是判别联合

```ts
type FileBrowserRequest =
  | { kind: 'workspace'; workspaceId: WorkspaceId; title: string }
  | { kind: 'file'; workspaceId: WorkspaceId; path: string; title: string; readOnly: true }
```

判别联合让「浏览工作区却只读」这种无意义组合在类型层面不可表达，组件对 `kind` 做穷尽 switch。

否决：
- **给现有 request 加可选 `path?` 与 `readOnly?`**——四个字段组合里有相当一部分没有意义，而类型不阻止它们。
- **新增独立的 `FileViewerModal` 组件**——内容区的四种降级渲染要复制一份，两份会各自漂移。

### D3 会话到工作区的解析放在客户端

`WorkspaceView.sessionIds` 已把每个会话登记到其工作区，工作区本身按会话 cwd 分组派生（`packages/workspace/workspace/src/index.ts` 的 `bootstrap`）。客户端用现有 `useWorkspaces` 快照按 `sessionIds.includes(sessionId)` 反查即可。

否决：
- **新增 Host 侧 `openSessionFile` Remote**——为一次纯客户端的集合查找增加一个协议面、一个错误码族与一份 Host 测试。
- **给 `fileBrowser.read` 加 session 寻址**——Remote 的寻址单位是工作区；让同一个读取有两种寻址方式会把授权问题复杂化。

反查不到工作区时（子代理会话、已归档会话的 cwd 未登记）明确提示，不静默回退 native 打开——静默回退正是本诉求要消除的行为。

### D4 只读是打开意图的属性，不是文件的属性

`readOnly` 由入口决定：会话链接一律 `true`，工作区菜单入口仍可编辑。`CodeEditor` 已有 `readOnly` 支持，只读态隐藏保存/重载/覆盖动作，保留复制与高亮。同一文件从两个入口进入得到两种可写性，这是入口语义。

### D5 native 打开降级为查看器内的次要入口

查看器内保留「用本地编辑器打开」，仅当 `connection.isLoopback` 且 `session.canOpenWorkspacePath()` 为真时渲染。目录路径（`ui-deliverables` 的「在文件夹中显示」）继续只走 native：文本查看对目录无意义。

### D6 不分页，沿用现有 `maxFileBytes` 上限

原设计考虑分页拉取。复用现有实现后改为沿用 `maxFileBytes`（默认 2 MiB）与 `too-large` 提示：`CodeEditor` 一次性接收全文并整体 tokenize，分页会要求把它改造成窗口化渲染，代价远超收益。超限时给出明确提示，并保留 native 入口。这是有意收窄——大文件在查看器里看到的是明确拒绝，而不是被截断的部分内容。

### D7 客户端经 `ctx.provide` 暴露门面

`ui-file-browser` 在 `apply` 中 `provide('fileViewer', { open })`，消费方用 `ctx.get('fileViewer')` 可选读取，缺席即「不提供」——与 `chatFileMentions` 的既有模式一致（`packages/client/ui-deliverables/src/client/index.ts`）。门面的 `open` 接收 `{ sessionId, path }` 并自己完成反查。

否决「各调用点各自反查工作区」：四处会重复同一段查找，且会话到工作区的映射只应有一个归属者。
