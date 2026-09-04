# 改造方案：标准模式（Chat view）UI 与 CodeBuddy 对齐

[English](gui-polish-standard-mode-rationale.md) | 中文

> 状态：待用户对齐
> 涉及分支：`feat/gui-polish-session-delete-resize-model-filter`
> 范围：`packages/client/ui-tool/*` + `packages/client/ui-chat/src/client/chat/ReasoningRow*` + `packages/client/ui-conversation/src/client/locales.ts`

## 一、原话诉求（用户输入）

> "标准模式"下，界面上输出的内容格式非常不好看，看习惯了 CodeBuddy 的界面，希望 deepseek harness 的界面输出能够与 codebuddy 的输出的界面类似，如：
> 1. 编辑的文件展示为：文件名 + 操作类型 + ±行数；右侧"查看变更"按钮；展开可见变更内容；
> 2. 深度思考的过程能够展示思考的过程，思考完成后再自动折叠起来，思考过程中默认展示的高度为 10 行左右，但是有滚动条可拖动；
> 3. 命令的执行默认展示 2 行，可点击右边的展示按钮查看全部，但是高度最多 10 行，超过 10 行通过滚动条滚动查看；
> 4. 文件操作要说明操作类型，如新增、编辑、删除；
> 如果改动时会影响到其它模式，相关的展示也按上述所示图进行改动。

## 二、需求拆解（4 个独立改造点 + 1 个跨模式影响面）

| # | 改造点 | 对应组件 | 用户期望 | 当前实现 | 差距 |
|---|---|---|---|---|---|
| R1 | 文件变更折叠行 | `ToolRow` + `FileMutationRow` + `diff-card-model.ts` | title 后面追加 `(修改)` / `(新增)` / `(删除)` 操作标签；右侧显式"查看变更"按钮 + chevron；展开看 DiffBlock | title 是变体名 "编辑"/"写入"，无操作标签；右侧只有 chevron 无"查看变更"文字 | 缺 operation label + 缺显式按钮 |
| R2 | 深度思考块 | `ReasoningRow.tsx` + `ReasoningRow.module.css` | 默认展开（约 10 行高度 + 滚动条）；思考完成后自动折叠 | 默认折叠，展开后无限高，无自动折叠机制 | 缺默认展开 + 缺 10 行限高 + 缺自动折叠 |
| R3 | Bash 命令块 | `BashRow.tsx` + `bash-sample.module.css` + `ToolRow.tsx`（terminal 分支） | 默认展示 2 行，可点击展开到最多 10 行（超出滚动条） | 完全折叠；展开后 TerminalBlock `maxLines=Infinity` | 缺默认 2 行 + 缺 10 行 cap |
| R4 | 操作类型枚举 | `tool-call-model.ts` + `diff-card-model.ts` + locale | 三种 operation：新增（create）、编辑（modify）、删除（delete） | 只映射 write/edit，无删除工具；locale 无 operation 文案 | 缺 delete 工具映射 + 缺 operation 文案 |
| X1 | 其它模式 | `ui-trajectory/*` | 如受影响，按相同规范改造 | Trajectory 完全独立渲染，**不复用** `ToolRow` / `FileMutationRow` / `BashRow` / `ReasoningRow` | 默认**不受影响**，需在变更文档明确 |

## 三、候选方案

### 方案 A：最小侵入（仅改样式层，保持所有 props/数据流不变）
- R1：在 ToolRow 末尾的 diffStat 区域旁边插入 operation label；保留 chevron 触发，新增"查看变更"文字按钮在 chevron 左侧
- R2：改 `useState` 初始值 + 加 `max-height` CSS + 加 `useEffect` 监听 running 状态变化后自动 setExpanded(false)
- R3：新增常量 `CHAT_TERMINAL_PEEK_LINES=2`、`CHAT_TERMINAL_MAX_LINES=10`；BashRow 拆出"折叠态"和"展开态"，折叠态用 TerminalBlock 但传 `maxLines=2` 并允许点 chevron 切到 `maxLines=10`，二次点击切到 Infinity
- R4：只新增 3 个 locale key 和 ToolRowModel 增加 `operation` 字段；不引入新工具

**优点**：改动面小，单测容易补；不影响 trajectory。
**缺点**：Bash 三态切换（2 → 10 → ∞）交互略复杂；"删除"工具未注册则 operation 永远是"修改/新增"，需要确认用户场景。

### 方案 B：完整对齐 CodeBuddy + 引入删除工具（推荐）
- 同方案 A 全部改造
- R4 扩展：在 `tool-call-model.ts` 的 `TOOL_VARIANTS` 中增加 `delete` / `remove` 工具映射（如果包系统没有 `delete` 工具，则保留映射接口但未注册）
- Trajectory 的工具 cell 用 TrajectoryCell 渲染，**与 Chat view 视觉风格保持一致**（同步改造，但保留独立事件投影）

**优点**：彻底对齐 CodeBuddy；删除场景预留；视觉风格统一。
**缺点**：Trajectory 同步改造工作量翻倍；引入删除工具可能超出当前 packages 边界。

### 方案 C：极致最小（只改样式不改交互）
- R2 改 CSS 高度限制
- R1/R3/R4 仅文案 + 样式，不改交互

**优点**：最快。
**缺点**：不符合用户原话"思考完成后再自动折叠起来""默认展示 2 行"等交互要求，被否决。

**推荐方案 A**：保留原架构、不动 trajectory、变更最小、4 个需求点全闭环。

## 四、关键边界（待用户拍板）

1. **删除工具是否本次新增？**
   - (a) 仅加 locale key 和模型预留字段，不引入删除工具（推荐）
   - (b) 在 `tool-call-model.ts` 注册删除工具的映射（但 packages 下若无 `delete` tool 则无意义）
   - (c) 跨 packages 给 `packages/tools/*` 新增删除工具（超出范围）

2. **Trajectory view 是否同步改造？**
   - (a) 不动 trajectory，明确文档说明（推荐，因为独立渲染）
   - (b) 同步改造 TrajectoryCell，视觉风格统一（工作量 +50%）

3. **Bash 三态切换（默认 2 → 点开 10 → 再点开 全部）还是两态（默认 2 → 点开 全部）？**
   - (a) 三态（更符合 CodeBuddy "最多 10 行"的语义，推荐）
   - (b) 两态（更简单，但失去 10 行上限保护）

4. **"查看变更"显式按钮还是仅 chevron？**
   - (a) 显式 "查看变更" 文字按钮 + chevron（推荐，对齐 CodeBuddy 图）
   - (b) 仅 chevron 不加文字（更轻量，但用户原话明确提到"右边的展示按锯"）

## 五、推荐实施计划（待用户确认后启动）

按 dev-workflow 9 阶段执行，按子任务串行：

| 批次 | 内容 | DoD 标志 |
|---|---|---|
| B1 | locale 新增 operation + 折叠行文案（zh/en） | 翻译键完整 + 单测断言存在 |
| B2 | R1：ToolRow + FileMutationRow 操作标签 + "查看变更"按钮 | 单测断言"修改"/"新增"渲染正确 |
| B3 | R2：ReasoningRow 默认展开 + 10 行限制 + running→false 自动折叠 | reasoning-row.client.spec.tsx 全绿 |
| B4 | R3：BashRow 三态（2/10/Infinity）+ 视觉与 ToolRow 对齐 | bash-sample / terminal-card 单测全绿 |
| B5 | R4：tool-call-model 加 operation 字段 + 删除工具预留 | 单测断言 operation 字段类型 |
| B6 | 局部回归：`pnpm -w run test:unit -- ui-tool ui-chat ui-conversation` | 0 回归 |
| B7 | changes/NNNN-gui-polish-standard-mode.md + README 索引 | 漏拦复盘段已写 |

## 六、风险与回退

- **风险 1**：ReasoningRow 默认展开会撑高 chat 流 → 用 max-height + overflow-y:auto 控制，CSS 加 `data-state` 切换
- **风险 2**：Bash 三态切换状态机增加心智负担 → 状态用 union type 强约束 + 单测枚举
- **风险 3**：locale key 命名与现有不一致 → 沿用 `row.*` / `tool.title.*` 命名空间
- **回退**：每个批次独立可 revert（git revert <commit>），互不影响
