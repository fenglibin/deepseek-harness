# 技术决策

### D1 尺寸调整只在 ui-file-browser 作用域内做

`Input`（32px / 14px）与 `Button` 的 `md`（36px / 14px）是全仓共享原子的默认几何，改它们会外溢到所有消费者。搜索框用 `FileBrowserModal.module.css` 里已有的 `.search` 容器覆盖（28px 高、13px 字号，与树行 `--dsw-font-xs-13` 同级），并收紧 `max-width`；内容区两个按钮直接改用 `Button` 已有的 `size="sm"`（28px / 12px），无需新增样式——12px 正是「已保存」的字号。

### D2 预览能力落在 `CodeEditor`，不新增第二个内容区

预览复选框属于内容区工具栏（路径、保存状态、重新加载、保存同处一行），该工具栏归 `CodeEditor` 所有。放进去之后，浏览器形态与只读形态同时获得它——两者渲染的就是同一个 `CodeEditor`。新增独立预览组件会让「已保存/未保存」状态、冲突横幅、只读态在各处复制一份。

### D3 预览是切换而非分栏

勾选后内容区由编辑器切换为预览，取消勾选回到编辑器并保留未保存的缓冲区。分栏会同时压缩源码与预览的宽度，而对话框左侧已经有一列目录树；切换让每一侧都能用满内容区宽度。

### D4 预览类型由扩展名决定，是 Client 侧的呈现事实

新增 `previewKindOfPath(path): 'markdown' | 'html' | undefined`，与既有 `languageOfPath` 并列（一个决定怎么呈现，一个决定怎么着色）。Host 只回答字节，呈现方式属于 Client。

- `.md` / `.markdown` → `markdown`
- `.html` / `.htm` → `html`
- 其余 → `undefined`，工具栏不渲染预览控件

### D5 Markdown 复用既有 `MarkdownText` 管线

`ui-primitives` 的 `MarkdownText` 已是本仓唯一 Markdown 渲染器：GFM（表格、任务列表、删除线）、KaTeX 数学、mermaid 流程图、脚注。README 对话框与轨迹视图都用它。传入 `diagrams: { errorLabel }` 即可得到流程图渲染。自建解析器会与它漂移，且要重新处理受限 HTML、相对链接与不安全协议的禁用规则。

### D6 HTML 用 `srcDoc` + `sandbox="allow-scripts"` 的 iframe

不给 `allow-same-origin`，文档落在不透明源：脚本可运行，而 `localStorage`、Cookie 与同源 `/api` 请求不可达。

否决：
- **完全禁脚本**——本仓已有实测记录（[从 web UI 打开产出的文件](../../../.agents/notes/implemented/feature/2026-07-31-web-workspace-file-links.zh.md)）：报告者工作区四份产物有两份在 CSP sandbox 下是死页面，且因为渲染得完美无缺，破坏不可见。产出 HTML 常靠脚本渲染内容。
- **`iframe src` 指向 Host 提供的路由**——那正是同一条 note 中实测把 `settings.describe` 与 `session.list` 打成 `200` 的路径，且要新增 Host 路由及其生命周期。

### D7 预览不引入新的 Host 面

`srcDoc` 由客户端已在内存中的缓冲区提供：无新 Remote、无新路由、不改会话日志、模型不可见。预览也因此能呈现未保存的修改。
