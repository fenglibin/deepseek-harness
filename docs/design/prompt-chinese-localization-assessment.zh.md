# D 方案评估：模型可见提示词中文化

> Status: 评估完成，待用户决策。本文只做规模、修改点、投入与风险量化，不含实施方案。

> 本文评估 `docs/design/chinese-only-localization.zh.md` 判断 A 明确排除的那件事：把**模型可见的英文提示词**整体中文化。该判断原文为「若需中文化，属独立工程」；本文是那项工程的规模、修改点、投入与风险评估，不是实施方案。

## 1. 背景

判断 A 把根 `AGENTS.md`、`docs/AGENTS.md`、`packages/AGENTS.md`、`.agents/notes/**/AGENTS.md` 保留为英文，理由是它们是给 AI 的 standing orders，本非双语配对文档，不构成「写两份」的负担。这个理由针对的是**翻译维护成本**，不针对**模型输出语言**。

但语言牵引力的问题恰恰出在这里：模型从上下文里占主导的语言续写。响应语言指令（`RESPONSE_LANGUAGE`，−950）是一段约 200 token 的约束，而它周围是数万字符的英文。指令是概率性的，英文语料是压倒性的——这是「输出大部分是英文」的结构性原因，也是响应语言指令反复加强却只能部分生效的原因。

## 2. 现状量化

从真实会话日志（`~/.dsh/sessions/.../session.jsonl.zstd` 的 `request/header`）实测：

| 来源 | 字符数 | 中文字符 | 注入位置 |
|---|---:|---:|---|
| system prompt 段落（21 段） | 8,471 | 0 | `header.system` |
| 工具 schema description（38 个工具） | 37,737 | 0 | `header.tools` |
| skills catalog | 9,023 | 0 | user message |
| workspace instructions（`AGENTS.md` 系列） | 9,419 | 2,857 | user message |
| **合计** | **64,650** | 2,857 | ≈ **16,162 token** |

判断 A 只覆盖最后一行（9,419 字符），而它已是其中唯一含中文的部分。**未覆盖的三项合计 55,231 字符，是判断 A 范围的 5.9 倍。**

### 2.1 system prompt 段落分布

21 段中，除响应语言指令本身外全部英文。最大五段：

| 段落 | 字符 | 归属 |
|---|---:|---|
| delivery 工具指引 | 1,567 | `packages/delivery/tool-delivery/src/index.ts:869` |
| Web surface 说明 | 991 | `packages/bundle/web-app/src/index.ts:144` |
| goal 工具指引 | 734 | `packages/goal/tool-goal/src/index.ts` |
| ralph 工具指引 | 434 | `packages/workflow/tool-ralph/src/index.ts:405` |
| web_search 指引 | 427 | `packages/web/tool-web/src/search.ts:315` |

注册点共 **39 处**，分布在 **30 个包**（`grep -rn "systemPrompt.section(\|systemPrompt.context("`，排除测试与 `lib/`）。

### 2.2 工具 schema

38 个工具，平均 991 字符/工具。`bash` 单个描述 1,836 字符，`create_delivery_task` 1,054 字符。这些文本与 system prompt 段落**是两套独立来源**：例如 `packages/fs/tool-fs/src/read.ts` 同时有第 69 行的 `systemPrompt.section` 段落文本和第 75 行起的 `defineTool` schema 描述，两者都要改。

## 3. 修改点

### 3.1 规模

| 类别 | 数量 | 位置 |
|---|---:|---|
| system prompt 段落注册点 | 39 | 30 个包的 `src/` |
| 工具 schema 描述 | 1238 处 `description:` | 全仓库工具包 |
| skills 正文 | 11 个 `SKILL.md`，107,946 字符 | `.agents/skills/`、preset 内置 |
| standing orders | 4 个 `AGENTS.md`，32,964 字符 | 根、`packages/`、`docs/`、`.agents/notes/` |

### 3.2 需要先做的架构决策

这是本次评估最重要的发现：**当前架构没有 prompt 文本的 i18n 机制**。`dsh-system-prompt` 只做装配（段落注册、排序、插值、渲染），不持有文本；文本散落在 30 个包的注册点里，以字符串字面量硬编码。客户端有完整的 locale 机制（`dsh-client-locale`，字典注册 + `t` 查找），但那套机制明确不适用于宿主侧——它依赖浏览器运行时。

因此在翻译任何文本之前，必须先回答「文本归属哪一层」：

**选项 1：就地改字面量。** 直接把 39 处段落文本与 1238 处 description 改成中文。
- 优点：零架构变更，改动机械。
- 缺点：DSH 是开源项目，英文部署失去英文提示词；海外用户拿到中文 prompt。这与判断 C 的处境相同但更严重——UI 中文尚可忍受，prompt 中文直接影响模型行为。

**选项 2：为宿主侧建一套 prompt 文本注册机制。** 新增类似 `dsh-prompt-locale` 的 row，各注册点从字典取文本。
- 优点：保留双语能力，与客户端 locale 决策对称。
- 缺点：这是**新能力接缝**（Service Definition + Provider + Consumer 三角色），39 个注册点全部要改造，且需要为每个注册点定义 key。投入远超选项 1。

**选项 3：只改 deployment 层可控的文本**（persona、Web surface、harness identity、source 段落），工具与 skills 不动。
- 优点：改动集中在 4 处（`packages/core/system-prompt/src/index.ts:414`、`packages/bundle/web-app/cordis.patch.yml:18`、`packages/bundle/web-app/src/index.ts:144`、`packages/boot/app-boot/src/index.ts:841`），可用 patch 层实现，无需改包。
- 缺点：只覆盖 1,481 字符，占英文总量 2.3%，**几乎不改变语言占比**。

### 3.3 与既有决策的关系

- **判断 A** 明确把这件事列为独立工程——本文即评估该工程，未推翻判断 A。
- **判断 C**（移除 UI 英文是产品级、不可逆变更）已确认执行。prompt 中文化是同类决策，但影响更深：UI 语言影响人的阅读，prompt 语言影响模型行为。
- `.agents/notes/implemented/feature/2026-09-11-response-language-directive-in-chinese.zh.md` 已确立「prompt 文本的书写语言是一个独立于机制的设计选择」，并记录该指令是仓库里第一段非英文 prompt。D 方案是该决策的规模化延伸。

## 4. 投入估算

按选项 2（保留双语，架构最正）计：

| 阶段 | 内容 | 估算 |
|---|---|---|
| 架构 | `dsh-prompt-locale` 能力接缝（定义/提供/消费三角色） | 新包 + 子系统文档 + Agent Note |
| 改造 | 39 个段落注册点接入字典 | 30 个包 |
| 改造 | 工具 schema 描述接入字典 | 1238 处，需为每个 key 命名 |
| 内容 | 翻译段落 + 工具描述（约 46,000 字符） | 人工审校 |
| 内容 | skills 正文（107,946 字符） | 人工审校，且 skills 面向模型亦面向人 |
| 验证 | 重建 golden | 见下 |

按选项 1（就地改）计：改动机械但同样要重建全部 golden，且不可逆。

### 4.1 验证成本（两个选项共有）

| 项 | 数量 | 说明 |
|---|---:|---|
| expected 文件总数 | 258 | `snapshots/` + `apps/`（含 `*.expected.json`） |
| 含英文 prompt 的 golden | 65 | 需重建 |
| `system-prompt.expected.md` | 28 | 需重建 |
| `tool-schemas.expected.json` | 29 | 需重建 |
| 含 `request/header` 的 expected jsonl | 158 | 需重建 |

重建需要可用的 API key 走 `test:snapshot:record`；手工改 fixture 会与录制器实际产出一致性无法保证（`docs/design/chinese-only-localization.zh.md` 与 09-02 Agent Note 都记录过这一点）。

## 5. 风险点

**R1 — 不可逆的产品级变更。** 选项 1 一旦落地，英文部署失去英文提示词。判断 C 的先例表明这类变更需要显式确认；prompt 比 UI 更靠近模型行为，回退成本更高。

**R2 — 模型行为回归无法预先验证。** 中文 prompt 对工具调用准确率、指令遵循率的影响没有基准数据。仓库已有先例：`2026-09-11-response-language-directive-in-chinese.zh.md` 记录「没有实测证据表明中文书写的指令遵循率更高，这是一个靠上线观察检验的假设」。D 方案把该假设放大到全部 prompt 文本。

**R3 — KV cache 前缀全量失效。** 段落文本变化使该段之后的前缀不可复用。D 方案改的是**全部**段落，因此每个会话的首个请求都从冷前缀开始。这是一次性成本，但会让首个 token 延迟与成本上升。

**R4 — golden 重建的规模与可重复性。** 65 份含 prompt 的 golden 加 158 份 jsonl 需重建。重建本身不难，难的是**审阅**：65 份 diff 里区分「预期变化」与「模型行为漂移」需要人工逐份确认。

**R5 — 双 SDK 投影。** `AGENTS.md` 要求 `SessionEventMap` 变更同步 TS 与 Python SDK 期望。实测 Python SDK（`python/sdk/`）当前不含英文 prompt 文本，因此本方案不触发该约束——但如果 prompt 文本进入任何 `SessionEventMap` 载荷，就会触发。

**R6 — 判断 A 的立场冲突。** `AGENTS.md` 系列是 standing orders，同时面向 agent 与人。中文化会改变其读者定位；`docs/AGENTS.md` 要求「Document current state, not change history」等规则本身是给模型的指令，翻译质量直接影响遵循率。

**R7 — 与 `minimal` 预设的交互。** 该预设 persona 是 `complete: true`，抑制全部其他段落。其 persona 文本（`You are a helpful software engineer assistant.`）若中文化，需与预设遮蔽机制一并考虑。

**R8 — 工具描述 key 命名的维护负担。** 1238 处 description 各需一个稳定 key。key 与工具同生命周期，工具增删时字典需同步，否则漏翻译静默回退英文——除非有门禁强制。

## 6. 建议

**不建议现在做全量 D。** 理由：

1. 最大两块（工具 schema 37,737 字符 + skills 9,023 字符）合计 46,760 字符，占英文总量 72%，而它们中文化的收益与风险都最高：工具描述直接影响模型调用准确率，skills 正文是模型执行工作流的依据。
2. 收益不确定而风险确定：R2 无基准数据，R3 与 R4 是确定的成本。
3. 选项 3（只改 deployment 层 4 处）投入极小、可逆、无需重建 golden，但只覆盖 2.3%——**性价比低到不值得单独做**。

**若要做，建议的顺序：**

1. **先量化收益。** 在受控条件下对比中文 prompt 与英文 prompt 的输出语言占比、工具调用准确率。这是 R2 的唯一解法，也是决定后续投入的依据。仓库已有 `snapshots/` 基础设施可复用。
2. **按风险从低到高推进。** 先做 system prompt 段落（39 处，46,000 字符中的一部分，行为影响可通过 golden 观察），再做工具描述，最后评估 skills。
3. **每批独立提交、独立验证**，与 `chinese-only-localization` 的分批策略一致。

**立即可做的替代方案：** 提高现有响应语言指令的约束力（已做：思考过程条款 + `zh` 默认值），以及在 deployment 层把 persona 与 Web surface 中文化（选项 3）。后者虽只占 2.3%，但 persona 位于提示词最前，对语言牵引的边际影响高于其字符占比。

## 7. 需要你确认的问题

1. DSH 的定位是「中文优先的产品」还是「中英双语的框架」？这决定选选项 1 还是选项 2。
2. 是否接受海外用户拿到中文 prompt？（判断 C 已对 UI 回答过同类问题）
3. 是否先做第 6 节的收益量化，再决定是否投入全量工程？
