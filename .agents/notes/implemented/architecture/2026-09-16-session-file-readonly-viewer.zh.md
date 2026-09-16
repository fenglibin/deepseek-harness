# Agent Note: 会话文件链接的只读查看

Status: implemented

## 问题

会话页面里的文件链接（chat 的产物提及、会话变更列表、交付卡片）点击后走的是 `session.openWorkspacePath`——Host 桌面打开器。这在两种场景下失效：云端部署的 Host 没有桌面环境，打开器失败；或者它在服务器上打开了文件，而用户在自己浏览器里什么也看不到。移动端访问时，用户手上的设备根本没有那个文件。

诉求是把「打开文件」重新定义为在浏览器中只读查看内容。[文件浏览器](2026-09-16-workspace-file-browser.zh.md)已经具备工作区受限读取与 shiki 语法高亮的全部能力，但它的入口只有工作区行菜单，且请求只携带 `workspaceId`，无法表达「打开这个具体文件、只读」。

这同时逆转了[从 web UI 打开产出的文件](../feature/2026-07-31-web-workspace-file-links.zh.md)的范围判断：它当时把「非本机客户端的预览」判出范围，理由是 Host 打开器完整回答受支持的场景。那条判断对**提供任意文档**仍然成立（同源提供不可隔离，`CSP: sandbox` 会杀死所服务的页面），但把文本读进产品自己的查看器不是提供文档，因此云端与移动端由本变更回答。

## 决策

### 扩展文件浏览器，不新建只读查看器

会话链接需要的内容区正是 `ui-file-browser` 已实现的（文本进编辑器、图片用 `<img>`、二进制与超限各有提示），差别只在**打开意图**与**是否可写**。因此新增一个注册点与一个门面服务，而不是第二套 Modal 与第二套 Remote 驱动。

### 打开意图是判别联合

```ts
type FileBrowserRequest =
  | { kind: 'workspace'; workspaceId: WorkspaceId; title: string }
  | { kind: 'file'; workspaceId: WorkspaceId; path: string; title: string; readOnly: true }
  | { kind: 'unavailable'; path: string; reason: 'no-workspace' }
```

判别联合让「浏览工作区却只读」这种无意义组合在类型层面不可表达，组件对 `kind` 做穷尽 switch。否决给既有请求加可选 `path?`/`readOnly?`：四个字段的组合里有相当一部分没有意义，而类型不阻止它们。

`unavailable` 是一个请求臂而不是返回的错误，因为这样「无法解析工作区时给出提示、且不回退桌面打开器」这条规则只有一处实现。静默回退正是本诉求要消除的行为。

### 只读是入口的属性，不是文件的属性

`readOnly` 由入口决定：会话链接一律 `true`，工作区菜单入口仍可编辑。`CodeEditor` 已有只读支持，只读态隐藏保存、重新加载与强制覆盖，保留语法高亮与复制。同一个文件从两个入口进入得到两种可写性，这是入口语义而非文件的固有属性。

### 会话到工作区的映射放在客户端

`WorkspaceView.sessionIds` 已把每个会话登记到其工作区（工作区本身按会话 cwd 分组派生，见 `packages/workspace/workspace/src/index.ts` 的 bootstrap），因此客户端用现有 `ctx.workspaces` 快照按 `sessionIds.includes(sessionId)` 反查即可。

否决新增 Host 侧 `openSessionFile` Remote：为一次纯客户端的集合查找增加一个协议面、一个错误码族与一份 Host 测试。也否决给 `fileBrowser.read` 加 session 寻址：Remote 的寻址单位是工作区，让同一个读取有两种寻址方式会把授权问题复杂化。

### 门面经 `ctx.provide` 暴露，缺席即关态

`ui-file-browser` 的 `apply` 中 `provide('fileViewer', { open })`，消费方（`ui-chat`、`ui-session-changes`、`ui-delivery`）用 `ctx.get('fileViewer')` 可选读取，与 `chatFileMentions` 的既有模式一致。门面的 `open({ sessionId, path })` 自己完成工作区反查，因此四处调用点不重复同一段查找，且会话到工作区的映射只有一个归属者。

门面缺席（插件未组合）时消费方保留原桌面打开器路径——那是组合层面的关态，不是失败回退。

### 目录动作继续走桌面打开器

产物行的「在文件夹中显示」目标是**目录**，文本查看对它无意义。它改经一个新注入的 `openNative` 走 `openWorkspacePath`，而文件 chip 继续经 `owner.openFile` 到达查看器。

### 桌面打开器降级为查看器内的次要入口

「用本地编辑器打开」只在页面就位于 Host 自身（`ctx.remote.$host.isLoopback`）时提供。二进制与超限文件也给出该入口，因为它们恰恰是查看器无法呈现、而本地编辑器可以打开的情形。

### 不分页，沿用 `maxFileBytes`

原设计考虑分页拉取。复用既有实现后改为沿用 `maxFileBytes`（默认 2 MiB）与 `too-large` 提示：`CodeEditor` 一次性接收全文并整体 tokenize，分页要求把它改造成窗口化渲染，代价远超收益。超限文件看到的是明确拒绝而不是被截断的部分内容，并保留桌面入口。

## 备选方案

**新建一个只读查看器包。** 否决：内容区的四种降级渲染要复制一份，两份会各自漂移；而会话链接与工作区浏览的差别只是入口语义。

**把打开意图作为可选字段挂在现有请求上。** 否决：见上，「浏览工作区却只读」应当不可表达。

**反查不到工作区时回退到桌面打开器。** 否决：那正是本诉求要消除的行为——云端与移动端场景下它同样失败或什么也不显示。

**Client 侧把绝对路径规范为工作区相对路径。** 部分否决：只有确实位于根之下的绝对路径才重定基。剥离前导斜杠会把根外路径静默重定位到根内的同名文件，由此掩盖 Host 的包含拒绝；根外路径原样传给 Host，由它报告拒绝。

## 后果

- 会话文件链接在云端、移动端与本地行为一致：都在浏览器中只读呈现。工具行里的文件路径也经聊天视图的同一个 `openFile`，因此同样受益。
- 超过 2 MiB 的文件在查看器里只得到提示与桌面入口，看不到部分内容。
- `ui-file-browser` 成为四个客户端包的 devDependency（仅为类型导入），并在 `ui-chat`、`ui-session-changes`、`ui-delivery`、`ui-deliverables` 的 tsconfig 中各加一条 project reference。
- 不改 `packages/api/file-browser` 的 Remote 协议，不改会话日志，不注册提示词或工具——模型不可见。

## 验证

- `packages/client/ui-file-browser/tests/view-target.client.spec.ts`（10 条）：会话到工作区的反查（命中、孤儿、空注册表），以及路径规范化（相对、根下绝对、根本身、根外绝对、同前缀兄弟目录、根尾随分隔符）。
- `packages/client/ui-file-browser/tests/file-browser.client.spec.tsx`（47 条，含新增 8 条只读查看）：直接打开且不列目录树、只读无保存动作、无树与搜索与新建、桌面入口按提供与否显隐、桌面入口传参、超限文件仍给桌面入口、`unavailable` 提示且不发起读取。
- `packages/client/ui-file-browser/tests/assembly.client.spec.tsx`（5 条，REAL composition，含新增 2 条）：经 `ctx.fileViewer` 打开会话链接得到只读视图且不列目录树；无工作区会话返回 `no-workspace` 并提示。
- `packages/client/ui-session-changes/tests/session-changes-dock.client.spec.tsx`：新增「查看器优先于桌面打开器」断言，并保留门面缺席时的桌面路径断言。
- `packages/client/ui-deliverables/tests/produced-files.client.spec.tsx`：断言「在文件夹中显示」走桌面打开器而非 `openFile`。
- 五个受影响包 `tsc --noEmit` 干净；37 个测试文件 513 项通过；改动包 oxlint 0 警告 0 错误。
