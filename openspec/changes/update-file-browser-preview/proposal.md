# 让文件浏览器的内容区能预览 Markdown 与 HTML

## 为什么

文件浏览器的工具栏与内容区有两处与页面其余部分不协调的尺寸：搜索框用了共享 `Input` 原子的 32px 高 / 14px 字号，在单行工具栏里明显偏高偏长；「重新加载」「保存」用了共享 `Button` 的 `md` 尺寸（36px / 14px），比紧邻的「已保存」12px 文字大一圈。

更重要的是，内容区对 Markdown 与 HTML 只能说「这是文本」：`.md` 文件显示为带高亮的源码，表格、流程图、公式都读不出来；`.html` 文件显示为源码，页面本身长什么样看不到。而本仓已经有一个成熟的 Markdown 渲染管线（`ui-primitives` 的 `MarkdownText`，支持 GFM 表格、KaTeX 数学与 mermaid 流程图），README 对话框与轨迹视图都在用它。

## 改什么

1. `FileBrowserModal.module.css`：搜索框在 `.search` 作用域内降为 28px 高、13px 字号，并收紧最大宽度。
2. `CodeEditor`：工具栏的「重新加载」「保存」改用 `Button` 已有的 `size="sm"`（28px / 12px），与「已保存」字号一致。
3. `CodeEditor`：新增 `previewKindOfPath`，`.md`/`.markdown` 与 `.html`/`.htm` 在工具栏多出一个「预览」复选框。
4. 勾选后内容区由编辑器切换为预览：Markdown 经既有 `MarkdownText`（开启 mermaid），HTML 经 `sandbox="allow-scripts"` 的 iframe 渲染当前缓冲区；取消勾选回到编辑器且保留未保存的修改。
5. 第 4 点的核查结论：会话页文件链接打开的只读查看器与工作区菜单打开的浏览器形态**本就复用同一个 `FileBrowserModal` 内容区与同一个 `CodeEditor`**，因此上述改动同时覆盖两个入口，无需第二套实现。

## 影响

- 改动 `packages/client/ui-file-browser`（CSS、`CodeEditor`、新的 `preview.ts`、locale、README、单测）。
- 不改 `packages/client/ui-primitives`：`Input` / `Button` 的默认几何是全仓共享的，覆盖只在本包作用域内做。
- 不新增包，不改 `packages/api/file-browser` 的 Remote 协议，不改会话日志，不注册提示词或工具——模型不可见。

## 用户可见的取舍

- 预览是**切换**而非分栏：勾选期间不能编辑，取消勾选回到编辑器。分栏会同时压缩源码与预览两侧宽度，在已有一列目录树的对话框里再切一刀。
- HTML 预览允许脚本运行但不给同源：产出 HTML 常靠脚本渲染内容，完全禁脚本会让相当一部分页面变成半死页面；不透明源下它仍拿不到 `localStorage`、Cookie 与同源 `/api`。
- 预览渲染的是当前缓冲区而不是磁盘内容，因此未保存的修改也能预览；保存状态仍由工具栏那一行陈述。
