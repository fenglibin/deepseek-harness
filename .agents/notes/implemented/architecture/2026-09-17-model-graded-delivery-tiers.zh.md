# Agent Note: 交付纪律以模型判定替换关键词分级

Status: implemented

## 问题

交付纪律用三张关键词表（强/中/弱信号）做忽略大小写的子串匹配来给请求定级。实测证明这个机制同时漏判与误判，而且两个方向的错误都不可修：

| 真实请求 | 旧判定 | 病因 |
|---|---|---|
| 把 `auth.ts` 里的注释改一下 | `l2` | 文件名里的 `auth` 命中强信号 |
| 调整 `ipc` 那个目录的 README | `l2` | 目录名命中强信号 |
| `replace` 相关的代码都替换掉 | `l2` | 中文 `替换` 与英文词干 `replac` 同义却各计一次 |
| 表演示一下这个界面 | `l0` | 只命中 1 个弱信号，而弱信号需 ≥2 才生效 |

根因是子串匹配没有词边界、不理解语义，也无法表达「修注释」与「改协议」的区别。加词条会扩大误伤，删词条会加重漏判——靠枚举无法收敛。

## 决策

### 分级改为「长度闸门 + 一次模型调用」

`gradeObjective`／`scanSignals`／`countHits`／`SignalHits`／`ExplainGrading` 与三份 `DEFAULT_*_SIGNALS` 词表一并删除。`src/grading.ts` 收缩为两个纯函数：`gradeByLength(objective, floor)` 与 `parseGradedLevel(text)`。

定级顺序：

1. 目标长度超过 `openspecThreshold.descriptionChars` → `l2`，不调用模型。
2. 否则发一次分级模型调用，系统提示词即 `gradingPrompt` 配置文本。
3. 模型自估值（`todo_count`／`touched_files`／`is_bug`）与 `requireOpenspecForBugs` 只在此基础上抬高分级，绝不压低。

长度闸门保留是因为它是唯一的机械判据：它拦的是「描述长」而非「语义重」，不存在词表的覆盖问题，且零成本。

`designThreshold.descriptionChars`（原 ≥60 字强制 `l1`）一并删除。它与 200 字闸门同类，留着会让大量普通请求在模型判定之前就被升为 `l1`，使模型判定对这部分请求形同虚设。

### 判定规则是可编辑文本，不是代码

`gradingPrompt`（默认见 `DEFAULT_GRADING_PROMPT`）承载全部 tier 规则，作为分级调用的 system 提示词。调整「什么算 L2」不再需要改代码。空值在 `resolveConfig` 被拒绝：空提示词会让每次判定都返回空、进而每次回退 `l1`，让一个误配置静默劣化所有分级。

模型只回一个分级标签；`parseGradedLevel` 先找独占一行的标签，找不到才取文本里第一个标签。这个顺序是必要的：句子「this is not l2, it is l1」同时点名两个 tier，只有独占一行的那个才是答案。

### 判定由独立调用执行，失败回退 l1

`agent/pre-step` 在无当前任务（或当前是 `l0`）且收到直接人类请求时 `await` 一次分级调用，拿到 tier 后再建任务——因此任务一开始就是最终级别，不需要事后提升。在 `pre-step` 中 await 辅助模型调用沿用 `compaction-basic` 的既有模式。

失败路径全部回退 `l1`：没有可用路由、调用抛错、超时（`DELIVERY_GRADING_TIMEOUT`，30 秒）或响应里没有分级标签。回退 `l0` 会让基础设施抖动变成纪律缺口，而 `l1` 的代价只是一条设计记录。

取消先例：这是本仓库第一个由 `pre-step` 发起的**新**模型调用，因此按「模型可见 ⟺ 已记录」新增 `delivery/grading-request` 会话事件（路由、系统提示词、消息、输出上限），在 dispatch 前 append。事件进入 `KNOWN_SESSION_EVENT_TYPES`（经 `gen-persistence-catalog` 重新生成）。

路由优先级：`lightweightModel.currentSelection()` → 会话最近一次 `requestHeader().config` → `agent.options`。分级是辅助分类，点名了廉价辅助路由的部署应当拿到那个模型。插件因此把 `llm` 加入 `inject`，并声明 `dsh-llm`／`dsh-lightweight-model`／`dsh-timeout` 依赖。

### 客户端把三个词表控件换成一个多行文本框

`DELIVERY_FIELDS.strongSignals`／`mediumSignals`／`weakSignals` 与对应的 8 个 locale 键删除，改为 `gradingPrompt`。`ValueField` 新增 `textarea` 支持（此前只渲染 `<input>`，且不应用 `.wide`）：一段提示词是散文，单行输入会藏住大部分内容。

## 备选方案

**保留词表，只把匹配改成整词边界。** 否决：能修掉 `auth.ts` 一类误伤，但「表演示界面」的漏判与同义重复计数仍在，词表覆盖不全的根本问题不变。

**只注入提示词、由主模型自行判定。** 否决：判定是否发生将取决于模型是否配合，正是[自动触发](2026-09-05-delivery-discipline-auto-trigger.zh.md)当初要消除的失效模式——那次真实会话里 delivery 工具调用次数为 0。

**辅助调用为主 + 主模型兼底的双路。** 未采用：单一路径实现面更小，且回退 `l1` 已保证判定失败也不会漏掉纪律。

**超时回退 `l0`。** 否决：模型调用失败时放行请求，等于让基础设施抖动变成纪律缺口。

**保留 60 字 L1 闸门。** 否决：它会在模型判定之前把大量普通请求升为 `l1`，使模型判定形同虚设。

**让分级结果成为新会话事件并记录 tier 依据。** 已做：分级依据写入 `.dsh/changes/<task-id>.md`，标明是 `character-floor`／`model`／`fallback` 中的哪一种，读的人能看到是什么决定了 tier。

## 后果

- **获得** 分级能理解语义：改注释与改协议不再被同一个词条判成同一级；判定规则成为可编辑文本，调整识别逻辑不需要改代码；判定失败有确定性的保守回退。
- **获得** `src/grading.ts` 从 256 行收缩到约 60 行，三份词表、词干解释与「新增条目避免互相包含」这类用户须知一并消失。
- **代价** 每个 ≤200 字的直接请求多一次模型调用与相应延迟（`pre-step` 会等它返回，与 `compaction-basic` 同一模式）。`l1`/`l2` 任务存续期间不再重复调用。
- **代价** 新增 `delivery/grading-request` 会话事件，属结构性格式新增（`KNOWN_SESSION_EVENT_TYPES` 重新生成）。
- **代价** 失败一律 `l1`，因此一个持续不可用的分级路由会让小修也带上一条设计记录。这是刻意选定的偏保守方向。
- **未决** `record_spec(kind: "tasks")` 经 `renderTasksMarkdown` 只按内容匹配更新已有行、保留其余旧行，连续两次整体改写清单时不同内容的行会累加而非替换，进而触发 `checklistMismatch`。属独立问题。
