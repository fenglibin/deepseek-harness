### D1 两个平面共用一个开关组件，落点分开
全局条目写 Loader 条目自身的 `disabled`；会话插件行写预设组合文件里那一行的 `disabled`。UI 上是同一个 `StateToggle`：写入后重新读取整份快照（有效状态与根 Fiber 阶段只有 Loader 真正拉起或停掉插件之后才答得出来），被拒时卡片保持展开并报告失败。放开 `trust === 'user'` 限制，`system` 预设也接受单行写入，写的是 `resolve()` 解析出的组合文件本身。

### D2 组合文件写入改为保注释的局部编辑
现有实现整体 `js-yaml` 重新 `dump`，会抹掉文件里全部注释与手写格式；随部署自带的 `standard/agent.cordis.yml` 有一百多行设计注释，一次开关就永久删掉它们。改为按行定位目标行块，只在 `disabled` 键那一行上增删：行块通过「扫描 `- ` 列表项 → 用 js-yaml 解析该块确认 `id`」定位，因此嵌套在 `group.config` 里的行、`id` 不是首个键的行都能命中。流样式（`- {id: x}`）追加新行会产生非法 YAML，这类行明确拒绝而不是猜测。启用是删掉这一行而不是写 `disabled: false`，与现有语义一致。

### D3 开关配色用语义色而不是 brand
`--dsw-alias-brand-primary` 在浅色外观是 `neutral-bluish-1000`、深色外观是 `neutral-bluish-50`，它是品牌墨色不是状态色。启用态改用 `--dsw-alias-state-success-primary`：两套外观都由主题定义，随外观自动变化，且「开」与成功色语义相邻。关闭态沿用 `--dsw-alias-border-l3`，滑块沿用前景反色。

### D4 复用 ui-primitives 的 MarkdownText，补 mermaid
`packages/client/ui-primitives/src/markdown/` 已是完整的 mdast → React 渲染器（GFM 表格、脚注、KaTeX、Shiki、增量流式）。查看器复用它，只补 mermaid：渲染上下文带 `mermaid` 开关且代码块语言为 `mermaid` 时，动态 `import('mermaid')` 后渲染成 SVG。动态 import 保证没有 mermaid 围栏时不加载这几百 KB。渲染失败退回代码块原文并给出原因，不让一篇文档因为一张图挂掉。

### D5 README 全文按需取
快照仍只带 frontmatter 的 `description`；每行新增可选 `readme` 字段，值是可读到的 README 文件名（`README.zh.md` 优先）——它同时是「是否显示查看更多信息」的依据。全文由新的 `pluginInventory/readme(moduleName)` Remote 在点击时惰性取回；几十个插件的全文不能进每次 `list` 的载荷。

### D6 弹窗形态与状态
复用 `ui-primitives` 的 `Modal`：居中、可滚动、Esc 与遮罩关闭，标题是模块短名称 + README 文件名。加载中、该插件没有 README、读取失败各有独立文案。

### D7 权限收紧保持不变
写入前仍然校验：组合文件必须是行列表、目标行必须由文件自己声明的 id 定位、带 `!!js` 门的行拒绝、原子写。删除预设的用户根目录收束逻辑不动。
