# 会话文件只读查看：扩展文件浏览器以支持单文件浏览

## 背景与目标

会话页面上展示的编辑/新增文件链接，点击后调用的是 Host 桌面打开器（`session.openWorkspacePath`）。这个行为在两种场景下失效：

- **云端部署**：Host 上没有桌面环境，打开器失败；或它在服务器上打开了文件，用户在自己浏览器里什么也看不到。
- **移动端访问**：用户手上的设备没有那个文件。

目标是把「打开文件」重新定义为**在浏览器中只读查看内容**，并复用已经存在的文件浏览器能力，而不是新建一套平行的文件读取通道。

## 现状：已存在的文件浏览器

`packages/api/file-browser` + `packages/client/ui-file-browser` 已经实现并合入（提交 `cb0d22a168`、`5bd5d60088`）。它的现状形状是**左右分栏的工作区浏览器**：左列懒加载文件树，右列内容区（文本走 `CodeEditor`，图片走 `<img>`，二进制与超限给提示）。

已具备的能力，本次直接复用：

| 能力 | 位置 |
|---|---|
| 工作区受限读取（realpath 包含检查） | `packages/api/file-browser/src/containment.ts` |
| 四臂内容判别（text / image / binary / too-large） | `packages/api/file-browser/src/workspace-io.ts` |
| 图片字节 Fetch 路由 | `packages/api/file-browser/src/index.ts` |
| shiki 高亮编辑器（含 `readOnly` 分支） | `packages/client/ui-file-browser/src/client/CodeEditor.tsx` |
| 扩展名 → 语言别名 | `packages/client/ui-file-browser/src/client/language.ts` |
| `shell.overlay` 浮层挂载 | `packages/client/ui-file-browser/src/client/FileBrowserOverlay.tsx` |

## 缺口

它当前只能通过「工作区行菜单」进入，且**入口只携带 `workspaceId`**。会话里的文件链接需要的是「带一个具体文件路径打开」以及「只读」两种新入口，并要从会话上下文解析出目标工作区。

## 技术决策

### D1 复用而非新建，扩展点放在 ui-file-browser

不新建只读查看器包。会话链接与会话变更列表需要的正是这个对话框已实现的内容区，差别只在**打开意图**与**是否可写**。新增第三个注册点与一个服务门面，而不是第二套 Modal。

### D2 打开意图是一个判别联合，不是可选字段

```ts
type FileBrowserRequest =
  | { kind: 'workspace'; workspaceId: WorkspaceId; title: string }
  | { kind: 'file'; workspaceId: WorkspaceId; path: string; title: string; readOnly: true }
```

判别联合让「打开到某文件」与「浏览某工作区」在类型层面互斥，`readOnly` 只出现在文件臂上，组件侧对 `kind` 做穷尽 switch。否决「给现有 request 加可选 `path?`/`readOnly?`」：那会让「浏览工作区却是只读」这种无意义组合变得可表达。

### D3 会话到工作区的解析在客户端完成

`WorkspaceView.sessionIds` 已把每个会话登记到其工作区，工作区本身按会话 cwd 分组派生（`packages/workspace/workspace/src/index.ts` 的 bootstrap）。因此客户端用`useWorkspaces` 的现有快照按 `sessionIds.includes(sessionId)` 反查即可，不需要新的 Host API，也不需要给 Remote 增加 session 寻址。

若查不到工作区（会话 cwd 未登记，例如子代理或已归档），降级为**不打开查看器并提示**，不静默回退到 native 打开——那正是本诉求要消除的行为。

### D4 只读是打开意图的属性，不是文件的属性

`readOnly` 由入口决定：会话链接一律 `true`。`CodeEditor` 已有 `readOnly` 支持，只读态下隐藏保存/重载/覆盖等编辑动作，仅保留复制与语法高亮。否决「按文件类型决定可写」：同一文件从工作区菜单进可编辑、从会话链接进只读，这是入口语义，不是文件的固有属性。

### D5 native 打开降级为查看器内的次要入口

查看器内保留「用本地编辑器打开」，仅当 `connection.isLoopback` 且`session.canOpenWorkspacePath()` 为真时渲染。目录路径（如产物行的「在文件夹中显示」）继续只走 native，不进查看器——文本查看对目录无意义。

### D6 不采用分页，沿用现有 2 MiB 上限

原设计考虑分页拉取。复用现有实现后改为沿用 `maxFileBytes`（默认 2 MiB）与`too-large` 提示：`CodeEditor` 一次性接收全文并整体 tokenize，分页会要求它改造成窗口化渲染，代价远超收益。超过上限时给出明确提示并保留 native 入口。这是**有意收窄**：大文件在只读查看器里看到的是明确拒绝，而不是部分内容。

### D7 客户端通过 ctx.provide 暴露 openFile 门面

`ui-file-browser` 在 `apply` 中 `ctx.provide('fileViewer', { open })`，需要打开文件的插件（`ui-chat`、`ui-session-changes`、`ui-delivery`）用`ctx.get('fileViewer')` 可选读取——未装该插件时缺席即「不提供」，与 `chatFileMentions` 的既有模式一致（`packages/client/ui-deliverables/src/client/index.ts`）。门面的 `open` 接收 `{ sessionId, path }`，由门面自己完成工作区反查。

否决「各调用点各自反查工作区」：三处会重复同一段查找逻辑，且会话到工作区的映射只应有一个归属者。

## 影响面

- `packages/client/ui-file-browser`：新增 `ctx.fileViewer` 门面、第三个注册点按需渲染、`FileBrowserRequest` 扩为判别联合、只读态接线、native 次要入口。
- `packages/client/ui-chat`、`ui-session-changes`、`ui-delivery`：`openFile` 改为经门面打开。
- `packages/client/ui-deliverables`：产物行与 `chatFileMentions` 改走门面；目录路径保留 native。
- 不新增包，不改 `packages/api/file-browser` 的 Remote 协议，不改会话日志，模型不可见。

## 验证

- ui-file-browser 单测：判别联合两臂、只读态隐藏编辑动作、工作区反查失败降级、native 入口的 loopback 与能力双重门控。
- 三处调用点的单测：点击链接经门面打开而非调用 `openWorkspacePath`。
- 组合测试：经 Loader 真实组合，断言会话链接可打开只读查看器。
