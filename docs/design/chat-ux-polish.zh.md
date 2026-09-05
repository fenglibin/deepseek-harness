# 对话 UX 打磨设计 — 六个面板级优化

> Status: 草稿，待用户确认后实施
> Audience: 维护者与决策者
> Related request: 对话面六个用户可见的小打磨，全部仅限客户端、每个都可独立回滚、不改动 agent-loop 与 session 协议。

---

## 1. 背景与动机

对话面被多次 Figma-first 打磨后留下一些小毛刺。协议与引擎没问题，但拼到用户面前仍显得粗糙。本设计把六个用户可见项收进一次变更，让共享的脚手架保持连贯：新建会话时的输入框、模型选择面板、语言指令、本次会话变更面板、瞬时错误通道，以及工具卡样式提升。

| # | 优化项 | 涉及文件 |
|---|---|---|
| 1 | 新建会话的输入框没有调整高度的手柄 | `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`、`InputBar.module.css` |
| 2 | 点击模型面板要先经过一个汇总层 | `packages/client/ui-model-selection/src/client/ModelSelect.tsx` |
| 3 | GUI 设置「中文」后 LLM 仍以英文输出 | `packages/context/response-language/src/index.ts`、`packages/client/ui-settings-general/...` |
| 4 | 没有会话修改文件列表，没有按文件保留/拒绝 | 新建包 `packages/client/ui-session-changes` |
| 5 | 重试已解决的错误仍占据页面 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`、facade notices |
| 6 | 编辑/写入工具行与其他工具行不易区分 | `packages/client/ui-tool/src/client/tool/components/ToolRow.module.css` |

每一项在协议层都独立 — 改动只触及客户端的 seam 代码（Slot / CSS / SystemPrompt 段 / 抽出的新包），最终可单独撤销。

---

## 2. Goals

- 一次性扫掉这六个可见的小毛刺。
- 文件列表参考 codebuddy 范式（按文件保留/拒绝，检查点分组），不动 Cordis、不动 agent-loop。
- 每个项目都落在现有扩展点上：chat/composer seat、model slot、system-prompt 注册表、新增的一个可组合 Slot、`conversation.composer.dock` 页脚、tool-row CSS。

## 3. Non-goals

- 不增加新的 wire protocol，不动 agent-loop，不加新工具 schema，不加 LLM 能力。
- 不为「查看变更」加新依赖 — 用户明确把此功能排除在本次之外。
- 不改 `tool/result` 事件形态；`isError` / content 字段维持原状。
- 除 `zh` 语言指令加固外不再改写 prompt。

---

## 4. Current state

### 4.1 复用的现有 surface

| Surface | 位置 | 本设计复用 |
|---|---|---|
| Composer 高度手柄（拖动 + 键盘 + 重置） | `ConversationRoot.tsx` `HeightHandle` | 项 1：同一拖动手柄，新增两个挂载点 |
| ModelSlot 两层面板 | `ui-model-selection/ModelSelect.tsx` `Pane` 状态机 | 项 2：触发时直接进入 model 面板 |
| `response-language` 系统提示段 | `packages/context/response-language/src/index.ts` `RESPONSE_LANGUAGE_SECTION` | 项 3：指令加强 + 读路径审计 |
| `ProducedFiles`（turn-tail slot，单行 chip 行） | `packages/client/ui-deliverables/` | 项 4：复用同一产出来源 |
| `conversation.input.dock` slot | `ConversationRoot.tsx` composer bar | 项 4：新增 dock surface `conversation.session.changes` |
| `InputNotice` snapshot store（`SessionInputShell.notices`） | `ui-conversation/.../facade.ts` | 项 5：清除陈旧错误 |
| `data-variant` on tool rows + diff card | `ui-tool/.../ToolRow.module.css` | 项 6：加 `data-variant=edit/write` 强调规则 |

### 4.2 架构约束

1. **Slot 组合而非 loop 改动**。所有新外观都走 Slot 模式，跟 `ProducedFiles` 一样 — orchestrator 与引擎不动。
2. **Locale-owned 文案**。每个新翻译走 `t('key')` 与包内 `locales.ts`，`zh` / `en` 一致用同一份 key 集合。
3. **Pre-release：foundation > blast radius**。停用 Slot 必须回到原行为；回滚 CSS 必须回到原外观。这约束项 4 的形态：独立包，不 fork `ui-deliverables`。
4. **直接文件回滚尚未做成一类能力**。`tool-fs` 的 write/edit 不在存储边界捕获每次调用的 previous-content。项 4 的拒绝路径需要给一个有边界策略（见 5.4），不是开放 undo 引擎。
5. **TypeScript 严格类型**。不允许 `any`，不允许 `@ts-ignore`。新增 Slot / 拒绝路径 projection 等五六行契约带 JSDoc，使用 `readonly` 数组。

### 4.3 代码摸排

- `ConversationRoot.tsx:521` 在 `phase === 'active'` 时才挂载 `<HeightHandle>`。未提交首轮的新会话是 `phase = 'hero'`。`InputBar.module.css:135-137` 同时显式强制 `.hero .scroll { height: auto }`。两处需要一起解开。
- `ModelSelect.tsx:29, 119-122, 248-263`：`Pane = 'root' | 'model' | 'effort'`。`show()` 总是进入 root 面板。若已选 model，effort 可能 undefined → effort cell 隐藏 → root 面板只剩一个「模型」可点击。删除 root 后直接进列表是一次状态变更 + 重新映射键盘语义。
- `response-language/src/index.ts:41-43`：只有 `zh` 有指令。原文「Reply to the user in Simplified Chinese (简体中文). Write every sentence a person reads in Chinese ...」。多个用户报 `auto` 模式仍是英文。两个真实候选：(a) locale preference 写入 `locale.preference` 链路失败 (b) 指令太软，模型回到 prior。我们两手抓：加固指令，加装定位日志。
- `ui-deliverables/turn-deliverables.ts:122-135`：`producedForClosing(data, seq)` 已是稳定的 per-turn mutation 列表（去重、首现序）。项 4 把它的可见面扩到会话级，但不复制数据源 — 订阅同一份 `turn-deliverables` 定义。
- `facade.ts:557-560`、`InputBar.tsx:97-106`：`notify(level, text)` 把 `this.notices.set({ level, text, seq: ++this.noticeSeq })`。错误会粘在头部直到下一次 `notify`。项 5 加 `clearNotices()` verb，由 session readiness 驱动调用。
- `ToolRow.module.css`：当前 `data-variant` 实际只有 `code` 一种，且 `[data-tool^='cordis_']` 是唯一带强调色的工具。`data-tool=write/edit` 走 diff card 但整行外观与 read / search / bash 一样。项 6 加 `data-tool=write` 和 `data-tool=edit` 的强调规则，配合现有的 `.operation`(写入)/(修改) 标记。

---

## 5. 候选方案

每个项给 ≥ 2 个候选、一个推荐方案、一个实现要点、撤销风险。

### 5.1 项 1 — 新建会话输入框需要高度手柄

**A. 让 `phase` 在 hero 下也挂 `HeightHandle`，移除 `.hero .scroll { height: auto }`。** *（推荐）*
同一手柄、同一拖动 / 键盘 / 重置 UX、同一持久化键（`localStorage` 的 `dsh.conversation.composerHeight`）、同一 `resolveComposerHeight` clamp。在 `hero` 与 `active` 都渲染手柄，删掉 `.hero .scroll { height: auto }`，让 hero 卡片高度也受同一个 `--dsh-composer-user-height` 变量约束。

- 优点：同一拖动 / 键盘 / 重置 UX，同一持久化键，同一 clamp。约 30 行 TSX/CSS。
- 缺点：hero 居中的内容卡被拖大后会显得比 figma 略重。我们用软下限（`COMPOSER_MIN`）兜底，现有 clamp 已经强制。

**B. 三段 `phase = 'hero' | 'hero-resizable' | 'active'`。**
否定理由：仅当 hero 路径需要不同于 active 的手柄样式时才值得单独一个 phase，没有这种需求。

**C. hero 不支持拖动，记为已知差异。**
否定理由：用户明确要求对齐。

### 5.2 项 2 — 点击模型触发直接弹出列表

**A. 触发直接进 `model` 面板，去掉根面板；effort 留作可点的下钻。** *（推荐）*
点击 trigger → `setPane('model')`。effort 在 model 列表内作次级下钻。两级菜单变成必选的一层（model）+ 可选的 effort 下钻。

- 优点：省去一次点击；effort 当存在时仍是单独控件。
- 缺点：reasoning 是 `efforts.length === 0` 且 `defaultEffort === undefined` 时，与之前行为完全一致。
**B. 保留根面板，无 reasoning 时把模型列表渲染到根里。**
否定理由：有 reasoning 的用户落进根面板、没有的用户直接落到列表，两条路径对用户的感知可以接受，但统一触发更简单也更贴合用户诉求。
**C. effort 独立成一个触发。**
否定理由：为许多模型根本没有的值翻倍 UI surface。

### 5.3 项 3 — GUI 设了「中文」就要中文输出

**A. 加强指令 + 审计读路径。** *（推荐）*
给 `zh` 指令加一条显式「禁止掉回英文」的条款，并审计 `localePreference` 相对 Web GUI 存储值的真实路径。审计把已有或缺失的 bug 暴露给我们；加固后的指令无论如何都能把模型拉回来。

新指令全文：

```
Reply to the user in Simplified Chinese (简体中文). Write every sentence a person reads
in Chinese — explanations, plans, progress updates, summaries, questions, and the
prose of commit messages, reports, and documents you author. Do NOT switch to English
when reproducing identifiers, paths, commands, or quoted user/tool output; quoted text
stays quoted, surrounding prose stays Chinese. If the user writes in English, mirror
their tone but keep your reply in Chinese unless they explicitly ask otherwise.
```

审计通过日志（`dsh.dev.trace` 门控）记录解析出的 `preference` / `environment` / 最终语言，下次复现就能定位是哪一环失败。

- 优点：影响半径小，无 model contract 变更，无新配置面；trace 日志 opt-in，会话结束即销毁。
- 缺点：沙箱下 `auto` 模式无 `en` 指令的事实仍在；一个 PR 里加不了 force-off 的中文行为（那需要 `en` 指令，项目会单独评估）。
**B. 加 `en` 指令做正控。**
否定理由：超出当前范围；是否加 `en` 指令是团队的既定取舍，今天缺省是有意为之。
**C. 改成 prompt context。**
否定理由：context 在 suppression 路径下会丢失；指令应当放在 section order -950，与 harness 身份和语言并列。

### 5.4 项 4 — 文件变更面板（按文件保留/拒绝）

**A. 新建包 `packages/client/ui-session-changes`，挂到 dock slot `conversation.session.changes`。** *（推荐）*
Slot 监听 `tool/call` + `tool/result` 对 `write`/`edit`/`str_replace_editor` 的成功结果，复用 `mutationPath()` 与 `turn-deliverables` 的产出口径，使已有的「产物」行继续生效。

**已确认决策（用户反馈）：**

1. **不做检查点分组。** 面板是单层平铺列表，按首次写入顺序排列，没有「检查点 N」文件夹，没有分组外观。
2. **拒绝不动文件。** 阶段一没有文件级回滚清单（`write` 会覆盖；`git checkout -- path` 会抹掉其它未提交工作）。拒绝动作写一条「撤销 <path>」进用户 TODO 列表，状态文案明确说明「这只是个提示，还没有做真正的还原」。用户选择了这条，而非静默 `git checkout` 或部分 git 还原。

卡片两态：

- **折叠** — 一行：`N 处变更 · 全部接受 / 全部撤销` 摘要 + 数量。
- **展开** — 每个变更文件一行。每行显示文件名（basename + 相对路径，复用现有 `basename`/`relativizeToCwd` helper）、操作（`写入` / `修改`）、两个动作：**接受**（从列表移除该行，磁盘结果保持工具写入的样子）与 **拒绝**（同样移除该行，并写一条 `撤销 <path>` TODO）。顶部「全部接受 / 全部撤销」对整表生效。

接受 / 拒绝只改面板状态；拒绝额外写 TODO。磁盘文件保持工具写入的结果不变。

- 优点：与 `ProducedFiles` 同样的 Slot 模式；新文件独立；`zh` / `en` 字典共置；无需维护检查点状态机。
- 缺点：v1 不做真正的文件回滚 —— 用户已明确接受。
**B. 在 `tool-fs` 加基线快照。**
否定理由：要给 FS 存储增加按 `(tool-call-id)` 建键的快照 sidecar，是对能力缝边界的深改动。这个需求是 UX 项，不是存储特性；用户也选了「先不做拒绝」。
**C. 扩展 `ProducedFiles` 直接做这一切。**
否定理由：把 per-turn 单行产出与跨 turn 的会话级状态混在一起，职责不清。拆两个包反而可读，fork `ui-deliverables` 会把它们耦合住。

### 5.5 项 5 — 重试已解决的错误不进页面

**A. 用 turn 的终局结果给 `model-retry` 节点设门：重试最终成功就隐藏失败详情，只有仍失败的 turn 才展示。** *（推荐）*

**已确认范围（用户反馈）：** 被重试解决掉的失败根本不应进入页面；只有重试没解决的失败才展示。不存在「事后清除」这一步 —— 判定在渲染时用 turn 的终局状态直接做出。

匹配「重试解决」的机制是 `llm-retry` 的自动 provider 重试：模型请求失败 → 调度 `llm/retry` → 等待后触发 `llm/retry-started` → 下一次请求要么成功（turn 正常关闭）要么耗尽策略（turn 以 `turn/end` `reason.kind === 'error'` 关闭）。

现状 `retry.ts` 的 `buildViewNode` 只要 `attempts.length > 0` 就物化 `model-retry` 节点，`ModelRetryItem` 把失败详情（`node.failure.message`）放在 `<details>` 里，重试成功后又留在 transcript 里 —— 这就是用户恢复后仍看到的「报错」。

修法在渲染层，落在 `retry.ts`：

- 从 `location.turn.end?.data.reason.kind` 读 owning turn 的终局原因。
- turn 关闭且 **不是** `kind === 'error'` → 重试链最终成功 → `buildViewNode` 返回 `null`（`model-retry` 节点不渲染，恢复掉的失败详情不进页面）。
- turn 关闭且 **是** `kind === 'error'` → 重试链没解决失败 → `model-retry` 照常渲染，兄弟 `turn-error` 节点已经承载终局失败。

进行中的反馈不受影响：turn 未关闭（`turn.end === undefined`）时，节点仍渲染中性的「重试中 / 已开始」状态，让用户看到正在重试；失败详情只在 turn 证明已恢复后才隐藏。

- 优点：单点判定，无 schema / 事件改动，「源头」就是 turn 自己的终局原因，恢复掉的失败根本不进 view 树。
- 缺点：节点一旦落库就是历史记录，所以「从没失败」与「失败但后续重试恢复」都由 `turn.end.reason.kind !== 'error'` 表示 —— 两者都隐藏详情，这正是用户要的行为。
**B. 重试恢复时自动 dismiss 瞬时 error toast。**
否定理由：toast（`InputBar` 的 `promptError` / `notices`）与重试链是两条独立通道；要跨通道打信号，还可能掩盖真正的发送失败。超出已确认范围。
**C. 改 `promptError` 的 TTL。**
否定理由：动了 session controller 已有的语义，避免。

### 5.6 项 6 — 编辑/写入工具行更醒目

**A. 加 `data-variant=edit` 和 `data-variant=write` 强调规则 + `(写入)` / `(修改)` 的 `.operation` 标记。** *（推荐）*
`ToolRow` 已通过 `data-tool` 写穿工具名；CSS 加：

- `data-variant=write` + `data-variant=edit`：左边 2px 竖条，用 `--dsw-alias-state-business-primary`。
- 一行 summary 单独调高一档色调：`.summary` 保持 tertiary，行上的强调边框 + `.operation` 里的 `(写入)` / `(修改)` 标记是可见的线索。
- hover：行加一层淡淡的 `--dsw-alias-interactive-bg-hover-solid` 底色，便于在长 transcript 里被光标找到。

- 优点：纯 CSS、零 JSX 改动、零新 key、零性能开销。
- 缺点：无；这是最便宜的项。
**B. 把整个 edit / write 卡片包一层着色面板 + 小标题。**
否定理由：增高 16px 在长 transcript 里与 figma 24px 单行基线冲突。
**C. 首次出现加一次性扫光。**
否定理由：`data-state='running'` 已经在扫光；叠加等于噪声。

---

## 6. 实施批次（每个文件/车道独立）

| # | 车道 | 涉及文件估算 | 风险 | 验证 |
|---|---|---|---|---|
| 1 | 新建会话输入框拖动 | `ConversationRoot.tsx`、`ConversationRoot.module.css`、`InputBar.module.css`、locales（`input.resize*` 已存在） | 低 — 同一手柄，两个新挂载点 | unit（`skeleton.client.spec.tsx` 拖动路径）、Playwright hero 拖动 |
| 2 | 模型选择单层 | `ModelSelect.tsx`、locales（`model.pane.title` 等） | 低 — 状态机翻转，无 schema 变更 | unit（`ModelSelect` 渲染 `available=true/false`） |
| 3 | 响应语言加强 | `response-language/src/index.ts`，可选 dev-trace 日志 | 低 — 文案 + 可观测性 | snapshot：`openspec / tests/system-prompt.spec.ts`（带新指令文本） |
| 4 | 文件变更面板 | 新 `packages/client/ui-session-changes/{src,tests}/`、`ConversationRoot.tsx` dock slot 挂载、可选 `ui-deliverables` locale | 中 — 新包、新 slot、新 definition；拆 2 子批（B1 词汇+接受+平铺列表、B2 展开+拒绝-为-TODO） | unit + e2e（`chat-view.client.spec.tsx` 带 stub 事件） |
| 5 | 重试已解决的错误不进页面 | `retry.ts`（`buildViewNode` 终局原因门） | 低 — 一处渲染期判定 | unit（`conversation-node-definitions.client.spec.ts` 加「已恢复 vs 终局」用例） |
| 6 | 工具卡强调 | `ToolRow.module.css`、`ToolRow.tsx`（仅 className 调整） | 无 — 纯 CSS | snapshot diff |

每个车道独立 PR / commit，顶部一段一图的设计 delta。

---

## 7. 测试计划

| # | Unit | Integration | Snapshot |
|---|---|---|---|
| 1 | `skeleton.client.spec.tsx` resize：`hero` + drag → stored pref → remount restore | `lifecycle-chrome.e2e.ts`（smoke-drag hero 手柄，持久化键） | 无 |
| 2 | `ModelSelect` 组件测试：`available=true` 点击 → state 落到 `model` 面板 | Playwright：zh / en 设置下点击 trigger，单层菜单可见 | snapshot for `modelSelect.menu` |
| 3 | `response-language.spec.ts`：directive text + preference（gui-set / en-host / zh-host / off） | dev-trace 抽样；`system-prompt.spec.ts`：zh 指令在、en 指令不在 | snapshot for `zh-system-prompt` |
| 4 | 新单测：`dock-render`、`flat-list-order`、`accept-flow`、`reject-flow` | 扩 `delivery` / `apps/web/tests/onboarding-usable-provider.e2e.ts` 单条流程：一次 edit → 拒绝显示 TODO 项 | snapshot for 折叠/展开 surface |
| 5 | `conversation-node-definitions.client.spec.ts`：重试 + turn/end error → 渲染；重试 + turn/end completed → 返回 null | `lifecycle-chrome.e2e.ts`：可恢复错误不留 retry 行 | snapshot for the recovered transcript |
| 6 | 视觉回归：`test:docs` / `test:snapshot` 两类 callout | 无 | snapshot for `ToolRow` style rows |

E2E：`pnpm dsh --profile headless "..."` 跑现有的 `apps/web/tests/onboarding-usable-provider.e2e.ts` 与 `models-settings.e2e.ts`；新增两个测试：
- `chat-ux-hero-resize.e2e.ts` — 拖 hero 手柄并验证 localStorage 持久化、恢复。
- `chat-ux-changes-accept.e2e.ts` — 模拟一次 edit 调用并接受；一次 edit + 拒绝后断言 TODO 插入。

---

## 8. 风险与对冲

| 风险 | 对冲 |
|---|---|
| 项 4 拒绝-为-TODO 在用户切换会话后丢失（TODO 是会话级） | 首版用现有 `todo_write`；文档记录这个缺口。后续改为在 session snapshot 持久 TODO，而非 per call |
| 项 3 指令加强可能撞到旧的 zh 文本 snapshot | 跑 `pnpm test:snapshot`；只重新拍摄受影响的 `zh-system-prompt` snapshot，snapshot 拥有同一 prose 身份（文件 keyed `production-build`，见 `snapshots/AGENTS.md`） |
| 项 5 隐藏 `model-retry` 失败详情，用户可能想查看到底重试了什么 | turn 未关闭时仍渲染中性「重试中 / 已开始」；只有已恢复的 turn 才隐藏详情。`turn-error` 节点与完整 trajectory 视图仍是重试未解决时的权威失败面 |
| 项 6 左竖条跟相邻行可能产生视觉错位 | 走内容侧 `border-left` 2px，不动外 box；现有 chevron 列已留位 |
| 项 1 hero 拖大后视觉过重 | `resolveComposerHeight` 在 hero 与 active 都用同一 clamp（列高减去 header budget） |

---

## 9. 已确认决策

以下已在实施前与用户对齐，实施将照此执行。

1. **项 3 指令口吻** — *实施时再定。* 指令要求中文、禁用英文回退，同时保留标识符 / 路径 / 代码 / 引文原文。§5.3 的加强文案在用户另有说明前保持不变。
2. **项 4 拒绝机制 — 已确认「先不做拒绝」。** 拒绝写一条「撤销 <path>`」TODO，状态文案明确说明这只是提示、没有真正还原。不做 `git checkout`、不动文件。
3. **项 4 面板布局 — 已确认不做检查点。** 按首次写入顺序的一张平铺文件列表；无「检查点 N」分组。
4. **项 5 — 已确认源头设门。** 被重试解决的失败根本不渲染；只有重试没解决的失败才展示。实现为 `model-retry` 节点的终局原因门（§5.5），没有「事后清除」这一步。
5. **项 6 强调色** — *实施时再定。* 计划 `--dsw-alias-state-business-primary` 作为 `edit/write` 左竖条，除非用户另选颜色。
6. **发布节奏 — 已确认原计划。** 1+2+6 一次 PR；3、5 各自一次 PR；4 自一次 PR 拆子批（B1 词汇+接受+平铺列表、B2 展开+拒绝-为-TODO）。

---

## 10. 后续工作（不在本次范围）

- 项 4 真正的文件回滚（要给 `tool-fs` 的 write/edit 加快照 sidecar）。单独跟踪。
- 项 4 在聊天内「查看变更」（用户排除；需要 dock slot 外的 viewer 接驳）。
- 项 3 加 `en` 指令（项目有意只在今天出 `zh`）。

---

## 11. 源点位置速查

| 主题 | 路径 |
|---|---|
| Composer seat + hero phase | `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx` |
| Composer height handle | `ConversationRoot.tsx` `HeightHandle` |
| Composer scroll / CSS | `InputBar.module.css` `.scroll` / `.hero .scroll` |
| Model picker | `packages/client/ui-model-selection/src/client/ModelSelect.tsx` |
| Response-language 指令 | `packages/context/response-language/src/index.ts` `DIRECTIVES.zh` |
| Locale preference 写入 | `packages/client/locale/src/locales/settings.ts` |
| Turn-tail 词汇（produced files） | `packages/client/ui-deliverables/src/client/turn-deliverables.ts` |
| Composer dock slot | `ConversationRoot.tsx` `renderSlot('conversation.composer.dock', zone)` |
| Conversation notice store | `packages/client/ui-conversation/src/client/input/facade.ts` `notices` |
| Tool row CSS / data-tool | `packages/client/ui-tool/src/client/tool/components/ToolRow.module.css` |
| Tool row markup | `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx` |
