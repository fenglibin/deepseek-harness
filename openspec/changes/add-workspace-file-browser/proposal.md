# 为 Web GUI 增加工作区文件浏览器

## 为什么

左侧工作区行的「...」菜单目前只有重命名与删除，运维人员在这个 GUI 里看不到工作区的文件，也无法就地修改配置或改一行代码——每次都要切回终端或外部编辑器。工作区已经是持久的目录注册（`ctx.workspaceRegistry`），把「浏览这个目录」做成菜单里的一个入口是最短的路径。

## 改什么

1. 新增 Host 包 `packages/api/file-browser`（`@deepseek-ai/dsh-api-file-browser`），提供 Remote namespace `fileBrowser`：工作区受限的目录列举、文本读取、文本写入、新建、重命名、删除、文件名搜索；另注册精确 Fetch 路由 `/api/file.asset` 供图片字节直连。
2. 新增 Client 插件包 `packages/client/ui-file-browser`（`@deepseek-ai/dsh-client-ui-file-browser`）：向工作区行菜单贡献「工作区文件」条目，并向 `shell.overlay` 注册文件管理器弹层（左树 + 右内容区）。
3. `packages/client/ui-workspace` 新增可插拔的 `ctx.workspaceRowMenu` 注册表服务；工作区行「...」菜单按它渲染贡献项，破坏性操作始终留在菜单末尾。
4. 内容编辑器复用 `ui-primitives` 现有的 shiki 单例做语法渲染（覆盖 TypeScript/JavaScript、Python、Ruby、Go、Rust、Java、C、C++、C#、Kotlin、Swift、PHP、shell、Lua、SQL，以及 JSON、YAML、TOML、INI、XML/HTML、CSS/SCSS/LESS、Markdown/MDX）；编辑态是 textarea 叠加在高亮层之上。
5. 非文本内容按类型降级：图片在右侧用 `<img>` 查看，其余二进制与超过上限的文件给出明确提示而不进编辑器。
6. 两个新包默认进入 web-app 组合。

## 影响

- 新增 `packages/api/file-browser`、`packages/client/ui-file-browser`（含 README、invariant companion、包骨架）。
- 改动 `packages/client/ui-workspace`：新增注册表服务、注入面投影、`Rows.tsx` 菜单渲染、README。
- 改动 `packages/bundle/web-app/cordis.patch.yml` 与 `package.json`、`tsconfig.host.json`、`tsconfig.client.json`、`packages/client/tsdown.client.ts`（若需放行新包 `/client` 出口）。
- `ctx.fs` seam、会话沙箱语义、会话日志均不变。
- 本功能不注册提示词、工具或会话事件，模型不可见。

## 用户可见的取舍

- 保存只受工作区根约束，不受会话沙箱模式限制：这是用户自己的显式编辑动作，不是模型行为。会话处于 `read-only` 时用户仍能保存自己的文件。
- 编辑器提供语法着色，不提供自动缩进、括号匹配与多光标——以零新依赖换取与现有高亮单例、主题 token 完全一致。
