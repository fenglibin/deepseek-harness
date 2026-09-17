---
description: "「查看变更」改为全屏覆盖层的并排 diff 设计草案：从内联单块改为 git / GitHub 风格的左右对照视图，含 shiki 语法高亮、行号、变更行背景、字符级行内高亮、空行占位对齐与差异跳转。"
kind: "design-draft"
---

# 「查看变更」并排 diff 全屏视图设计

## 目标与范围

把「查看变更」从 dock 内联展开的单块 `DiffBlock`，改为**全屏覆盖层**中的**并排（side-by-side）diff**，阅读体验对齐 git difftool / GitHub 的 split view。

用户已确认的三项取舍：形态与仓库既有的「文件浏览器」一致采用全屏覆盖层；布局只做单文件并排 diff（不做左栏文件列表）；打磨程度要求完整 git 体验。

非目标：不改 Host 侧 `sessionFileRevisions.diff` 的语义（仍是 baseline → endState）；不做多文件并排比较；不做编辑（视图只读）。

---

## 1. 现状与问题

当前 `RevisionDiffPanel` 由 dock 直接渲染在条带下方（`SessionChangesDock.tsx:483-492`），内容是一块 `DiffBlock`。`DiffBlock` 是**统一格式（unified）**：先列全部 `-` 行、再列全部 `+` 行（`DiffBlock.tsx:102-110`），且默认 16 行后折叠中部（`DEFAULT_DIFF_MAX_LINES`）。这带来三个问题：

1. **空间不足**：dock 是输入框上方的一条窄带，长文件几乎立即折叠。
2. **无法对照**：统一格式把删除与新增分列两处，读者要在脑中上下对照才能理解一次替换。
3. **缺少定位线索**：没有行号、没有语法高亮，长文件里定位改动靠肉眼扫。

---

## 2. 已确证的技术前提

| 前提 | 依据 |
|---|---|
| `shell.overlay` 是 root 作用域的 list 槽位，可新增独立覆盖层 | `packages/client/ui-layout/src/client/index.ts:86`、`:130` |
| 既有全屏对话框范式：`apply` 闭包内共享一个 observable 请求源，触发方 publish、覆盖层订阅 | `packages/client/ui-file-browser/src/client/index.ts:131-145`、`:205-215`；`FileBrowserOverlay.tsx` |
| `Modal` 原语支持 `headless` 模式与 body 滚动，尺寸可由调用方 CSS 覆盖 | `packages/client/ui-primitives/src/Modal.tsx:41-85`；`FileBrowserModal.module.css:13-21`（`min(1180px, 94vw)` / `min(820px, 92vh)`） |
| 客户端已有 shiki 单例与懒加载语法，API 为 `highlightLines(raw, lang)` + `subscribeGrammarLoaded` | `packages/client/ui-primitives/src/markdown/highlight.ts`；导出见 `src/index.ts:60`；用法见 `ReadBlock.tsx:82` |
| 文件扩展名 → 语言提示的映射已存在 | `packages/client/ui-file-browser/src/client/language.ts` |
| `diff` 库在客户端已有先例（`ui-trajectory` 已依赖） | `packages/client/ui-trajectory/package.json:51` |
| `diff` 的 `structuredPatch` 给出 hunk 级 `oldStart`/`newStart` 与逐行 ` `/`-`/`+` 标记 | 本机实测输出 |
| 删/增配对算法可把一次替换压成同一行、空缺侧留空位 | 本机实测输出（`b→B`、`d→NEW` 同行，`a`/`c`/`e` 对齐） |

---

## 3. 设计决策

### D1 触发与承载：dock 发布请求，root 覆盖层订阅

dock 的「查看变更」不再切换内联面板，而是 publish 一个打开请求；新注册的 `shell.overlay` 条目订阅该请求并渲染全屏视图。两者通过 `apply` 闭包内的一个共享 observable 连接，与文件浏览器同构——这是仓库既有的、已验证的跨作用域触发方式（session 作用域的触发方驱动 root 作用域的承载方），不引入新的机制。

请求内容：`{ sessionId, path, fileCount }`，或在无记录时 `undefined`（关闭）。

### D2 覆盖层形态：复用 Modal 的 headless 模式 + 自有尺寸

使用 `Modal headless`，由本包 CSS 给出与文件浏览器一致的框架尺寸（`min(1180px, 94vw)` / `min(820px, 92vh)`），头部为文件路径 + `+A -R` 统计 + 关闭按钮，正文区独立滚动，底部为差异跳转条。`headless` 而非默认头部的理由：diff 需要自有的头部布局（路径、统计、跳转控件同排），而默认头部的标题/描述/关闭三件套无法容纳。

Esc、遮罩点击、关闭按钮三条退出一致保留（来自 `Modal`）。

### D3 并排渲染：删增配对为一行，空缺侧留占位

核心数据变换：把 `structuredPatch` 的 hunk 行序列折叠成 `[left, right]` 行对。

- 相邻的连续 `-` 行与连续 `+` 行**配对**：第 i 个删除对第 i 个新增，占用同一行。
- 一侧多出的部分补 `null`，渲染为该侧的空占位（`git difftool` 的行为），因此两栏始终等高、行号对齐。
- 上下文行两侧相同。
- 行号分别来自 hunk 的 `oldStart`/`newStart` 递增计数；空位侧不编号。

### D4 折叠范围：默认全文件展开，只折叠超长文件

与 `DiffBlock` 的"16 行后折叠中部"不同：全屏视图**默认展示完整文件**，因为空间已经充足，折叠会再次制造"看不到全貌"的问题。仅当行数超过上限（默认 2000 行，进 `Config` 之外的常量）时折叠中部并保留展开控件，避免超大文件卡住浏览器。

### D5 高亮：按语言提示走既有 shiki 单例，懒加载语言不阻塞

语言由路径扩展名经 `language.ts` 的同源映射推出。两侧都用 `highlightLines`。语法未加载时先渲染纯文本、加载完成后重渲染（订阅 `subscribeGrammarLoaded`），与 `ReadBlock`/`CodeEditor` 的既有取舍一致。未知扩展名退化为纯文本，绝不报错。

**行内字符级高亮**：对配对成功且两侧都存在的行，用 `diffChars` 计算差异区间，在删除行标出被移除片段、在新增行标出新增片段。配对失败或任一行为空位时跳过。

### D6 长行与滚动：两栏同步横向滚动

两栏各自 `overflow: auto`，横向滚动同步（一侧滚动带动另一侧），使同一列在两个版本里保持对应。纵向滚动由外层统一承担，两栏不各自纵向滚动——否则行会错位。

### D7 导航：上一处/下一处差异与统计

底部条提供「上一处/下一处差异」跳转（在 hunk 之间移动并滚动到位）与 `+A -R · N 个文件` 统计。跳转索引来自 hunk 列表，当前 hunk 高亮。这是 git difftool 最有用的导航能力，也是当前实现完全没有的。

### D8 既有能力的保留

- `DiffBlock` 继续服务会话内的工具调用卡片（不删除、不改语义），本设计只替换 dock 的「查看变更」承载。
- `withheld` 的三种状态（`oversized` / `baseline-missing` / `null` 且空）沿用现有文案，在覆盖层正文区展示。
- 失败文案与错误码分派（`revisionFailureText`）原样复用。
- 复制按钮保留：复制的是**统一格式**文本（`-`/`+`），而不是并排的视觉布局——粘贴出去要仍是标准 diff。

---

## 4. 影响面

| 位置 | 改动 |
|---|---|
| `packages/client/ui-session-changes/src/client/` | 新增并排视图组件与请求源；dock 改为 publish；删除旧的内联面板渲染路径；新增 CSS 与 locale 键 |
| `packages/client/ui-session-changes/src/client/index.ts` | 追加 `shell.overlay` 注册 |
| `packages/client/ui-session-changes/package.json` | 新增 `diff` 依赖（与 `ui-trajectory` 同版本） |
| 测试 | 新增对齐算法单测、字符级差异单测、覆盖层交互测试；更新既有 `revision-diff.client.spec.tsx` |

Host 侧、Remote 契约、会话日志与快照均不变。

---

## 5. 风险

- **对齐算法是唯一有真实逻辑复杂度的部分**，必须用单测锁住边界：纯新增、纯删除、替换、行数不等、空文件、只有一行、末尾无换行符。
- **字符级高亮对超大单行可能昂贵**：需对单行长度设上限，超过则该行只做整行高亮。
- **两栏横向滚动同步**需防止回环（一侧 scroll 事件触发另一侧、又反向触发）。
- **性能**：全文件展开 + 双栏高亮在数千行文件上会变慢，因此 D4 的折叠上限是必要约束而非可选优化。
