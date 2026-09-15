# 技术决策

### D1 工作区行菜单的扩展点是一个注册表服务，不是新 slot

`ui-workspace` 拥有 `sidebar.workspaces` 并渲染工作区行，因此由它 `ctx.reflect.provide` 出 `ctx.workspaceRowMenu`，模式与既有的 `ctx.sessionProjections.register`、`ctx.commands.register` 一致。贡献项只承载 JSON 兼容数据与一个回调：

```ts
interface WorkspaceRowMenuContribution {
  id: string
  label: string
  order?: number
  danger?: boolean
  onSelect: (workspace: WorkspaceView) => void
}
```

`label` 由贡献方用 `ctx.locale.bind(ns)` 绑好再传入，字典仍归贡献方所有。

否决：
- **声明一个 `sidebar.workspaces.rowMenu` slot**——slot 的货币是 ReactNode 组合，而这里需要的是「数据 + 回调」的增量列表；且新 slot 的 owner 是 ui-workspace 自己，贡献方拿不到 owner 渲染时机之外的东西。注册表服务才是这个形状。
- **在 ui-workspace 内联该项并探测可选服务**——改动更小，但第二个插件想加菜单项时还要再改一次 ui-workspace，且卸载路径把菜单项与探测分支耦合在一起。
- **贡献项携带 icon**——icon 是 ReactNode，禁止跨 UI 域传递；为单个消费者预造 `iconId` 枚举不符合「要求当前所有者与需求」。

### D2 Host 落点是单个自包含包 `packages/api/file-browser`

它自带 `workspace-io.ts`，不拆成「IO 服务 + Remote 包装」两个包：该 IO 能力只有这一个消费者，按 capability-seam 规则，单消费者时不该造独立 seam。它也不放进 `packages/fs/fs-local`——那是 `ctx.fs` 的本地后端实现，往里加第二服务会让该包承担两种角色。

### D3 安全边界：解析工作区根 + realpath 包含检查

每个方法接收 `workspaceId`，用 `ctx.workspaceRegistry.get()` 解析根路径，目标 `realpath` 后检查包含关系（同 `packages/fs/fs-sandbox/src/containment.ts` 的模式），越界抛 `file-browser/outside-workspace`。用 realpath 而非纯词法比较是因为符号链接可以指向工作区外，纯词法检查会放过它。Fetch 路由与 Remote 共享同一份检查实现，不复制第二份。

### D4 `read` 的判别联合承载「仅文本可编辑、图片可查看」

```ts
| { kind: 'text'; text: string; version: string; size: number; truncated: boolean }
| { kind: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; size: number }
| { kind: 'binary'; size: number }
| { kind: 'too-large'; size: number; limit: number }
```

判定顺序：先按扩展名识别图片，再按大小判 `too-large`，最后按内容采样判二进制（含 NUL 或非法 UTF-8）。默认上限 2 MiB。`truncated` 恒为 false，保留它是为了让将来支持截断预览时不必改协议。

语言判定放在 Client：扩展名 → 语言别名是表现层事实，Host 返回它会把展示细节带进协议，而 `ui-primitives` 的别名表本就是 client 侧唯一权威。

### D5 写入用版本乐观锁与同目录原子发布

`version` 取 `mtimeMs + size` 的摘要，`write` 带上它；不匹配抛 `file-browser/stale`，客户端提示「文件已在磁盘上变化」并给「重新加载 / 强制覆盖」。省略 `version` 表示无条件写。原子发布用同目录临时文件 + `rename`（与 `packages/fs/fs-local/src/fsio.ts` 相同机制），同目录保证 rename 不跨设备。

### D6 图片字节走精确 Fetch 路由

`/api/file.asset?workspaceId=..&path=..`，用 `connection.fetch.register` 注册（`session-log-export` 的既有用法），浏览器 `<img src>` 直连。否决「Remote 返回 base64」：体积膨胀 33%、整图进内存、大图体验差。

### D7 Client 侧两处注册共享一份打开状态

`packages/client/ui-file-browser` 的 `apply` 内有两次注册：`ctx.workspaceRowMenu.register()` 贡献菜单项，`ctx.slots.inject('shell.overlay', ...)` 注册 Modal。两者共享 apply 闭包内创建的可观察「打开请求」源——菜单项的 `onSelect` 推送，Modal 通过 inject 的 `hooks` 订阅。不引入 store（该状态不需要跨重挂载存活），不引入模块级单例（apply 是唯一合法创建点）。

### D8 编辑器是 shiki 高亮层 + textarea 叠加

按用户确认复用现有 shiki 单例，不引入 CodeMirror/Monaco。结构是相对定位容器内两层完全对齐：底层 `<pre>` 渲染 token（负责呈现），上层透明 `<textarea>`（负责编辑与光标），textarea 的 `scroll` 同步给 pre。复用 `highlightLines()`，未保存时按当前内容重新 tokenize（受控 + 防抖）。代价是编辑体验为纯文本编辑加彩色底纹，没有自动缩进与括号匹配——用户已知并接受的取舍。

### D9 树懒加载与默认过滤

点开一层才 `list` 一层。默认隐藏 dotfile 与 `node_modules`、`.git`、`dist`、`build`、`target`、`.venv`、`__pycache__` 等重目录，面板头部有「显示隐藏项」开关。文件名搜索由 Host 递归遍历（带上限，超出时 `truncated` 为 true），Client 以扁平结果列表呈现，点击跳转并展开到该文件。不做文件内容搜索。

### D10 默认进入 web-app 组合

与 `ui-workspace`、`ui-session-changes` 一致，开箱即用。Remote 的 descriptor、codec 与 declaration merge 由 tsdown 的 typert 插件在构建时生成（`packages/typert/generator/src/tsdown-plugin.ts`），不手写生成物。
