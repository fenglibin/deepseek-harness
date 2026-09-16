# 文件浏览器：设计与技术决策

## 目标

在 dsh Web GUI 的左侧工作区行「...」菜单里增加「文件浏览器」入口，点击后弹出一个文件管理器：左侧树形目录，右侧展示选中文件内容，文本可编辑保存并带语法高亮，图片只查看。

## 可行性结论与两个硬约束

### 能力齐备的部分

| 需求 | 现成能力 |
|---|---|
| 语法高亮 | `packages/client/ui-primitives/src/markdown/highlight.ts` 已有 shiki 单例（fine-grained core + JavaScript regex engine），语言覆盖面已满足要求：TypeScript/JavaScript、Python、Ruby、Go、Rust、Java、C、C++、C#、Kotlin、Swift、PHP、shell、Lua、SQL，以及 JSON/JSONC、YAML、TOML、INI、XML/HTML、CSS/SCSS/LESS、Markdown/MDX。非启动语法按需懒加载，未知语言回退纯文本。 |
| 树形浏览 UI 先例 | `packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx` |
| Host↔Client 通道先例 | `packages/api/workspace-controller/src/directory-picker.ts`（Remote）、`session.attachment`（base64 图片） |
| 大文件字节通道先例 | `packages/session-query/session-log-export/src/index.ts` 用 `connection.fetch.register` 注册精确 Fetch 路由 |
| 全帧浮层挂载点 | `shell.overlay`（`packages/client/ui-layout/src/client/index.ts:86` 已声明的 list slot） |
| 删除确认先例 | `ui-primitives` 的 `RiskConfirmation`（ui-workspace 已在用） |

### 约束一：`ctx.fs` 不支持目录操作

`packages/fs/fs/src/index.ts` 的 `FileSystem` 抽象类只声明了 `resolve`、`processPath`、`fileUrl`、`contains`、`stat`、`lstat`、`readText`、`streamText`、`readBytes`、`listDir`、`writeText`、`editText`。**没有 mkdir / remove / rename**。

因此「新建 / 重命名 / 删除」不能落在 `ctx.fs` 上。按用户确认，新插件包自带一个窄 Host 实现（`node:fs/promises` + 自实现临时文件原子发布），边界就是工作区根。理由：

- 不动核心 seam（扩展它要改抽象类型 + `fs-local` + `fs-sandbox` 两个后端 + 围栏语义，影响面最大）。
- 写入语义与用户确认的口径一致：**这是用户显式的编辑动作，不受会话沙箱模式限制**，只受工作区根约束。若复用 `fs-sandbox`，会话处于 `read-only` 时用户将无法保存自己的文件——与期望相反。
- 插件因此完全自包含、可单独卸载。

### 约束二：工作区行「...」菜单是硬编码的

`packages/client/ui-workspace/src/client/rows/Rows.tsx:129` 的 `workspaceMenuItems` 只有 `rename` 与 `delete` 两个条目，没有任何扩展点。这是唯一必须改动既有功能文件的地方。

## 技术决策

### D1 新增可插拔的 `ctx.workspaceRowMenu` 注册表服务

由 `ui-workspace` 拥有并提供（它是 `sidebar.workspaces` 的 owner，也是菜单的渲染者），模式与现有 `ctx.sessionProjections.register`、`ctx.commands.register` 一致。

贡献项只承载 JSON 兼容数据与 callback——遵守「UI 域之间只传 JSON 兼容数据和 callback，ReactNode 走 slot」的既有规则：

```ts
export interface WorkspaceRowMenuContribution {
  id: string
  label: string
  order?: number
  danger?: boolean
  onSelect: (workspace: WorkspaceView) => void
}
```

按用户确认，贡献项**不含 icon**：icon 是 ReactNode，跨 UI 域传递被禁止；为此新增一个受限 `iconId` 枚举属于为单个消费者预造词汇，不符合「要求当前所有者与需求」。

`register()` 返回 disposer，跟随调用方 fiber 生命周期（HMR 安全）。

否决：
- **在 ui-workspace 内联该项并探测可选服务**——改动更小，但属于硬耦合；`ui-file-browser` 卸载后菜单项消失是对的，可第二个插件想加菜单项时还得再改一次 ui-workspace。
- **用 `ctx.slots` 声明一个新的 menu slot**——slot 承载 ReactNode 组合，而这里需要的是「数据 + 回调」的增量列表，且 `single` cardinality 的 slot 会被后注册者替换。注册表服务才是这个形状。

### D2 Host 侧落点是单个自包含包 `packages/api/file-browser`

`@deepseek-ai/dsh-api-file-browser`，Remote namespace `fileBrowser`。它自带 `workspace-io.ts`（工作区受限的 node:fs 操作）而不是拆成「IO 服务 + Remote 包装」两个包：IO 能力只有这一个消费者，按 capability-seam 规则，单消费者时不该造独立 seam。

被否决的落点：
- **放进 `packages/fs/fs-local`**——它是 `ctx.fs` 的本地后端实现，往里加一个第二服务会让该包承担两种角色。
- **扩展 `ctx.fs` seam**——见约束一。

### D3 安全边界：每次调用解析工作区根 + realpath 包含检查

每个 Remote 方法都接收 `workspaceId`，Host 用 `ctx.workspaceRegistry.get()` 解析出根路径，再把目标用 `realpath` 规范化后检查包含关系（与 `packages/fs/fs-sandbox/src/containment.ts` 同一模式）。越界抛 `file-browser/outside-workspace`。

realpath 而非纯词法比较的原因：符号链接可以指向工作区外，纯词法检查会放过它。toctou 残余（检查与 syscall 之间祖先被换掉）在这个威胁模型下可接受——调用者是已认证的本地 GUI 用户，不是不可信代码。

### D4 大小上限与二进制降级由 `read` 的判别联合承载

`read` 返回四臂联合，这就是「仅文本可编辑、图片可查看」的落点：

```ts
| { kind: 'text';   text: string; version: string; size: number; truncated: boolean }
| { kind: 'image';  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; size: number }
| { kind: 'binary'; size: number }
| { kind: 'too-large'; size: number; limit: number }
```

上限默认 2 MiB（按用户确认）。判定顺序：先按扩展名识别图片；再按大小判定 `too-large`；再按内容采样判定二进制（含 NUL 字节或非法 UTF-8 序列）。`truncated` 恒为 false（超限直接走 `too-large`），保留该字段是为了让 wire 形状在将来支持「截断预览」时不必改协议。

**语言判定放在 Client 而非 Host**（按用户确认）：扩展名 → 语言别名是表现层的事实，Host 返回它会把展示细节带进协议；且 `highlight.ts` 的别名表本来就是 client 侧的唯一权威。

### D5 写入用版本乐观锁

`version` 取 `mtimeMs + size` 的组合摘要，`write` 带上它；不匹配抛 `file-browser/stale`，客户端提示「文件已在磁盘上变化」并给「重新加载 / 强制覆盖」两个选项。`write` 省略 version 表示无条件写。

原子发布用同目录临时文件 + `rename`（与 `fs-local/src/fsio.ts` 一致）：同目录保证 rename 不跨设备。

### D6 图片字节走精确 Fetch 路由，不走 Remote

`/api/file.asset?workspaceId=..&path=..`，用 `connection.fetch.register` 注册（`session-log-export` 的既有用法），浏览器 `<img src>` 直连。否决「Remote 返回 base64」：体积膨胀 33%、整图进内存、大图体验差。

路由与 Remote 共享同一个包含检查实现，不复制一份。

### D7 Client 侧是一个插件包，两处注册共享一份打开状态

`@deepseek-ai/dsh-client-ui-file-browser`。`apply` 内有两次注册：

1. `ctx.workspaceRowMenu.register()` 贡献菜单项；
2. `ctx.slots.inject('shell.overlay', ...)` 注册 Modal。

两者共享的是 apply 闭包内创建的一个可观察「打开请求」源：菜单项的 `onSelect` 推送请求，Modal 通过 inject 的 `hooks` 订阅它。不引入 store（不需要跨重挂载存活），不引入模块级单例（apply 是唯一合法的创建点）。

### D8 编辑器是 shiki 高亮层 + textarea 叠加

用户确认复用现有 shiki，不引入 CodeMirror/Monaco。结构：

```
┌─ 行号槽 ─┬────────── 内容区（相对定位）──────────┐
│   1      │  <pre>  shiki token（彩色，只读）      │  ← 底层，负责"看"
│   2      │  <textarea> 透明文字 + 可见光标       │  ← 上层，负责"编辑"
└──────────┴──────────────────────────────────────┘
```

两层字体、行高、padding 严格对齐；textarea 的 `scroll` 事件同步给 pre。复用 `highlightLines()`，未保存时按当前内容重新 tokenize（受控 + 防抖）。代价是编辑体验为纯文本编辑 + 彩色底纹，没有自动缩进与括号匹配——这是用户已知并接受的取舍。

### D9 树懒加载、默认过滤、搜索在前端呈现

- 树懒加载：点开一层才 `list` 一层。
- 默认隐藏 dotfile 与 `node_modules`/`.git`/`dist`/`build`/`target`/`.venv`/`__pycache__` 等重目录；面板头部有「显示隐藏项」开关。
- 文件名搜索：Host 侧 `search` 递归遍历（带上限与 `truncated`），Client 以扁平结果列表呈现，点击跳转并展开到该文件。不做全文内容搜索（用户确认范围是文件名）。

### D10 默认进入 web-app 组合

用户确认。与 `ui-workspace`、`ui-session-changes` 一致，开箱即用。

## 数据流

```
菜单项 onSelect(workspace)
  → 打开请求源
  → Modal 挂载，调 fileBrowser/list(workspaceId, undefined, showHidden)
  → 树节点展开：fileBrowser/list(workspaceId, nodePath, showHidden)
  → 选中文件：fileBrowser/read(workspaceId, path)
      text  → CodeEditor（highlightLines + textarea）
      image → <img src="/api/file.asset?...">
      binary / too-large → 提示，不给编辑器
  → 保存：fileBrowser/write(workspaceId, path, content, version)
      ok    → 更新 version，清除 dirty
      stale → 冲突提示（重新加载 / 强制覆盖）
```

## 错误码

`file-browser/outside-workspace`、`not-found`、`stale`、`exists`、`invalid-name`、`unreadable`、`too-large`、`unsupported`。

## 影响面

新增：
- `packages/api/file-browser`（Host 包 + `/client` 类型出口 + invariant companion + README）
- `packages/client/ui-file-browser`（Client 插件包 + invariant companion + README）

改动：
- `packages/client/ui-workspace`：新增 `ctx.workspaceRowMenu` 注册表服务、注入 face 投影、`Rows.tsx` 渲染贡献项、README。
- `packages/bundle/web-app/cordis.patch.yml` 与 `package.json`：两个新包各 +1 行。
- `tsconfig.host.json` / `tsconfig.client.json`：各 +2 references。
- `docs/subsystems/slots.zh.md`（若 slot 树变化）、`docs/subsystems/web-client.zh.md`（若层描述需要）。

不变：`ctx.fs` seam、会话沙箱语义、会话日志、模型可见输入（本功能不注册提示词、工具或会话事件，模型完全不可见）。

## 测试策略

- Host 单测：越界拒绝（含符号链接逃逸）、`stale` 冲突、二进制降级、大小上限、重命名冲突、删除非空目录、搜索上限、名称校验。
- Client 组件测试：树展开/折叠、选中、编辑后保存、冲突提示分支、删除确认分支、图片/二进制/超大文件渲染分支。
- REAL-composition 测试：按 `packages/AGENTS.md`，product-visible 插件必须经 Loader 真实组合启动一次（手搭 `ctx.plugin()` 不够）。
- GUI 冒烟：`DSH_SNAPSHOT=replay pnpm run test:web`。

## 范围外

文件内容全文搜索、文件监视与自动刷新、多标签页、下载、执行文件、工作区根之外的任何访问。
