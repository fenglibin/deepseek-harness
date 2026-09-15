# Agent Note: 工作区文件浏览器与工作区行菜单扩展点

Status: implemented

## 问题

Web GUI 只能在左侧看到工作区与 Session，看不到工作区里的文件，也无法就地改一行配置或代码——每次都要切回终端或外部编辑器。工作区已经是持久的目录注册（`ctx.workspaceRegistry`），把「浏览这个目录」做成工作区行菜单里的一个入口是最短路径。

两处约束决定了实现形态：

- **`ctx.fs` 没有目录操作。** `packages/fs/fs/src/index.ts` 的 `FileSystem` 只声明 `resolve`/`stat`/`lstat`/`readText`/`streamText`/`readBytes`/`listDir`/`writeText`/`editText`，没有 mkdir/remove/rename。扩展这条 seam 要同时改抽象类型、`fs-local` 与 `fs-sandbox` 两个后端以及围栏语义。
- **工作区行「...」菜单是硬编码的。** `packages/client/ui-workspace/src/client/rows/Rows.tsx` 的 `workspaceMenuItems` 只有重命名与删除，没有任何扩展点。

## 决策

### 一个自包含的 Host 包承载工作区受限的文件操作

`packages/api/file-browser` 拥有 `fileBrowser` Remote 命名空间与 `/api/file.asset` 字节路由。它自带基于 `node:fs/promises` 的 IO，而不复用 `ctx.fs`，理由是这三条同时成立：README 的目录操作缺口意味着复用也只能省下一半实现；用户在这里保存文件是自己的显式动作，若走 `fs-sandbox` 则只读会话里连自己的文件都改不了，与期望相反；不受 seam 约束使该插件完全自包含、可单独卸载。

IO 能力只有这一个消费者，因此不拆成「IO 服务 + Remote 包装」两个包——按 capability-seam 规则，单消费者时不该造独立 seam。

### 包含检查用 realpath，并用同一份实现守住两条入口

每个方法都从 `workspaceId` 解析根目录，把目标规范化后检查它仍在根之下。用 `realpath` 而非词法前缀比较，因为工作区内的符号链接可以指向外部而词法比较会放过它；不存在目标（一次新建）解析其最深的已存在祖先，因为那才是新建落地处。

字节路由与 Remote 共用这一份实现：图片路径与文本路径是同一个信任问题，第二份实现会成为第二个可能漂移的地方。

### `read` 的判别联合就是「文本可编辑、图片可查看」的落点

```
text       内容在大小上限内且采样判定为 UTF-8 → 进编辑器，带版本令牌
image      PNG/JPEG/WebP/GIF → 用返回的 url 加载
binary     采样含 NUL 或非法 UTF-8 → 只报大小
too-large  超过 maxFileBytes → 报大小与上限
```

只有 `text` 分支携带内容进入编辑器，因此「仅文本可编辑」不是编辑器的纪律，而是类型的事实。判定顺序是图片扩展名、大小上限、内容采样，所以超大图片仍按图片呈现。

图片 URL 由 Host 在 `read` 结果里给出，而不是客户端拼装：路由路径与它的查询约定属于注册该路由的这个包，客户端只消费。

### 写入是版本守卫加同目录原子发布

`read` 的 `text` 分支返回 `mtimeMs:size` 摘要作为版本令牌；`write` 带上它时，磁盘已变化就拒绝而不是静默覆盖；省略则无条件写。发布方式是同目录下唯一命名的临时文件加 `rename`——同目录放置正是让重命名不跨设备、从而保持原子性的原因。

### 工作区行菜单的扩展点是注册表服务，不是新 slot

`ui-workspace` 拥有并渲染工作区行，因此由它 provide `ctx.workspaceRowMenu`，模式与 `ctx.sessionProjections.register`、`ctx.commands.register` 一致。贡献项的货币是 JSON 兼容数据加一个回调：

```ts
interface WorkspaceRowMenuContribution {
  id: string
  label: string
  order?: number
  danger?: boolean
  onSelect: (workspace: WorkspaceView) => void
}
```

标签由贡献方用自己的 locale 命名空间绑好再传入，字典仍归贡献方。贡献项不含图标：图标是 ReactNode，跨 UI 领域传递被既有规则禁止，而为单个消费者预造一个 `iconId` 枚举不符合「要求当前所有者与需求」。

### 客户端两个注册共享一个闭包持有的请求源

`packages/client/ui-file-browser` 的 `apply` 内注册菜单项与 `shell.overlay` 弹层各一次。菜单项把被点击的工作区推入一个可观察的「打开请求」源，弹层订阅它。该状态既不需要跨重挂载存活（不入 store），也不能是模块级单例（`apply` 是唯一合法创建点），所以放在闭包里。

对话框是唯一持有服务端状态的地方，树与编辑器只渲染被交给它们的数据；因此新建、重命名、删除各自该刷新哪一层都只有一处实现。

### 编辑器是高亮层叠一个透明 textarea

下层 `<pre>` 渲染 shiki token，上层透明 `<textarea>` 负责编辑与光标，两层共用字体、行高与内边距。着色器是 `ui-primitives` 里那个唯一的 shiki 单例，颜色取自 `--shiki-*` 主题变量，未识别扩展名回退纯文本。

## 备选方案

**扩展 `ctx.fs` 加 mkdir/remove/rename。** 语义最统一，但改抽象类型加两个后端加围栏语义是本变更里影响面最大的一条；且在只读会话下会让用户无法保存自己的文件。

**用一个 `sidebar.workspaces.rowMenu` slot 承载菜单项。** 否决：slot 的货币是 ReactNode 组合，而这里需要的是数据加回调的增量列表；且该 slot 的 owner 会是 ui-workspace 自己，贡献方拿不到 owner 渲染时机之外的东西。

**在 ui-workspace 内联「工作区文件」并探测可选服务。** 改动更小，但第二个插件想加菜单项时还要再改一次 ui-workspace，且卸载路径把菜单项与探测分支耦合在一起。

**引入 CodeMirror 或 Monaco。** 否决：以零新依赖换取与现有高亮单例、主题 token 完全一致，代价是编辑体验为纯文本编辑加彩色底纹，没有自动缩进与括号匹配——这是明确接受的取舍。

**图片字节走 Remote 返回 base64。** 否决：体积膨胀 33%、整图进内存、大图体验差；精确 Fetch 路由在仓库里已有先例（`session-log-export`）。

## 后果

- 保存只受工作区根约束，不受会话沙箱模式限制。这是刻意的：它是运维人员对自己工作区的显式编辑动作，不是模型行为。
- 包含检查与随后的系统调用之间存在残余 TOCTOU（祖先符号链接被替换）。对已认证的本地 GUI 调用者，这个威胁模型可接受，与 `fs-sandbox` 的既有判断一致。
- 版本令牌由 `mtimeMs` 与 `size` 组成，因此同一毫秒内写入同样长度的内容不会被识别为一次变化。
- 不做文件监视：磁盘上的外部改动只通过保存冲突与手动重新加载进入视图。
- 两个新包默认进入 web-app 组合；移除该行即同时移除菜单入口、弹层与 Host 侧命名空间贡献。

## 验证

- `packages/api/file-browser/tests/workspace-io.host.spec.ts`（49 条）：包含（含符号链接逃逸与允许的内部链接）、四条内容分支、版本守卫的接受与拒绝、新建/重命名/删除、名称校验、搜索上限与只匹配名称、图片字节的越界拒绝。
- `packages/api/file-browser/tests/controller.host.spec.ts`（16 条）：每个结构化拒绝到线上错误码的映射、可配置边界、字节路由的注册形状与四类拒绝。
- `packages/client/ui-file-browser/tests/file-browser.client.spec.tsx`（38 条）：懒加载树、隐藏项开关、截断、四种内容呈现、编辑保存与 Ctrl+S、冲突的重新加载与强制覆盖、新建/重命名/删除确认与取消、搜索定位、关闭时不发起调用。
- `packages/client/ui-file-browser/tests/assembly.client.spec.tsx`（3 条，REAL composition）：真实 `apply` 经真实 `ctx.workspaceRowMenu` 贡献菜单项、点击后弹层列出所请求工作区的根目录、销毁插件 fiber 后菜单项与弹层一并消失而内置动词仍在。
- `packages/client/ui-workspace/tests/`（163 条）无回归；两个 tsconfig 编译面干净；改动包 lint 0 警告 0 错误；`verify-cordis-config`、`verify-client-packages`、`verify-package-dependencies`、`verify-client-ui-i18n`、client bundle 纯净性与 CSS 门禁、`gen-client-catalog` 与 `gen-tsconfig-paths` 均通过。
