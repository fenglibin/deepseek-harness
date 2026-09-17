# 用 LLM 判定替换交付纪律的关键词分级

> 目标读者：维护者
> 关联：[自动触发方案](delivery-discipline-auto-trigger-rationale.zh.md)、[分级复核范围与悬浮卡片](../../.agents/notes/implemented/feature/2026-09-15-delivery-grading-review-and-float-card-visibility.zh.md)、[l0 纳入自检与验收命令排序](delivery-l0-selfcheck-and-command-ordering.zh.md)

## 背景

交付纪律用三张关键词表（强/中/弱信号）做忽略大小写的子串匹配来决定任务分级。实测证明这个机制既漏判又误判：

| 真实请求 | 实际判定 | 问题 |
|---|---|---|
| 把 `auth.ts` 里的注释改一下 | **L2** | 文件名里的 `auth` 命中强信号，改注释被判成结构契约级变更 |
| 调整 `ipc` 那个目录的 README | **L2** | 目录名命中强信号 |
| `replace` 相关的代码都替换掉 | **L2** | 中文 `替换` 与英文词干 `replac` 同义重复计数，一条命中被算成两条 |
| 表演示一下这个界面 | **L0** | 只命中 1 个弱信号，弱信号需 ≥2 才生效 |
| 优化一下这个查询的性能，涉及子任务拆分 | **L1** | 4 个弱信号叠加，虽判对了但依据是词频而非语义 |

根因是子串匹配没有词边界、不理解语义、也无法表达「修注释」与「改协议」的区别。词表越长误伤越多，缩短又漏判——靠枚举永远无法覆盖。

## 已确证事实

| 事实 | 位置 |
|---|---|
| 匹配是忽略大小写的子串包含，不支持正则与词边界 | `packages/delivery/tool-delivery/src/grading.ts` `countHits` |
| 分级顺序：>200 字 → L2；强 ≥1 → L2；中 ≥2 → L2；中 1 或弱 ≥2 → L1；否则 L0 | 同上 `gradeObjective` |
| `pre-step` 中 await 辅助模型调用已有先例 | `packages/compaction/compaction-basic/src/index.ts` 的 `agent/pre-step` 监听器 |
| 辅助调用范本：路由 + 超时 + 校验 + 确定性回退 | `packages/session/session-title-llm/src/index.ts` |
| 用户可指定辅助调用的廉价路由 | `packages/core/lightweight-model/src/index.ts`，已挂载于 base 组合 |
| `GenerateOptions.purpose` 是封闭联合，适配器有消费点 | `packages/llm/llm/src/types.ts`、`llm-deepseek/src/adapter.ts` |
| 新开的模型调用必须能在会话日志重建 | 仓库规则「模型可见 ⟺ 已记录」 |

## D1 删除三张词表，只保留长度闸门

`strongSignals`/`mediumSignals`/`weakSignals` 三个 `Config` 字段、settings schema 字段、三份 `DEFAULT_*` 常量、`countHits`/`scanSignals`/`SignalHits` 与其客户端标签控件一并删除。

唯一保留的机械分级是「目标文本长度 > 200 字符 → L2」：超长请求几乎必然是多点交付，这条闸门确定性、零成本，且它拦的是「描述长」而非「语义重」，不存在词表的覆盖问题。

同时按用户决定删除 `designThreshold.descriptionChars`（原 ≥60 字强制 L1）。它与 200 字闸门是同一类长度 proxy，留着会让大量普通请求在 LLM 判定之前就被升为 L1，等于绕过 LLM。

## D2 判定由独立辅助 LLM 调用执行

`agent/pre-step` 在收到直接人类请求且无当前任务时，发一次辅助模型调用并把分级规则作为 system 提示词传入，解析返回的分级后据此建任务。

选它而非「注入提示词让主模型自己判」：后者在模型不遵守时判定就不发生，正是[自动触发方案](delivery-discipline-auto-trigger-rationale.zh.md)要消除的失效模式——那次会话里 delivery 工具调用次数为 0。独立调用把「判定是否发生」从模型的配合里拿回来。

**代价与对策**：

- **每步阻塞。** `pre-step` 是 waterfall，await 会推迟该步。`compaction-basic` 已在同一位置 await 模型调用，模式已确立；但判定只在无当前任务时才发，一次会话里的直接请求数有限。
- **失败必须有确定性回退。** 超时、调用失败或返回不可解析时回退到 `l1`（不是 `l0`）：判定失败的请求应当得到纪律，而不是静默地自由执行。回退路径写日志。
- **需要日志事件。** 新开的模型调用按「模型可见 ⟺ 已记录」必须留有事件，记录路由、system、messages 与输出上限，仿 `session/title-llm-request`。
- **路由选择。** 优先级为：`lightweightModel.currentSelection()` → 会话最近一次的请求头路由 → agent 自身路由。前三者皆无时回退到 `l1` 而不发调用。

## D3 判定规则是可配置提示词

分级规则不再由代码里的中文/英文词表承载，而是一段 `gradingPrompt` 配置文本，作为辅助调用的 system 提示词。调整识别逻辑不再需要改代码。

模型必须只返回一个分级标签。解析取响应文本里第一个出现的 `l0`/`l1`/`l2`（忽略大小写），解析不出即按 D2 的回退处理。

默认文本承载原有语义判据（结构契约变更 → `l2`；跨端、跨包、新功能、需要设计决策 → `l1`；局部小修 → `l0`），但去掉了词表依赖。客户端交付纪律卡片把三个词表控件换成这一个多行文本控件。

## D4 `create_delivery_task` 保留模型自估值

`todo_count`/`touched_files`/`is_bug` 与 `requireOpenspecForBugs` 保留：它们不是关键词匹配，而是模型在创建任务时自己给出的规模估计，规则求值是确定性的，不存在「词表覆盖不全」的问题。`inferLevel` 相应收缩为「长度闸门 + 这些自估值 + bug 强制」，不再调用 `gradeObjective`。

## 备选方案

**保留词表，只把匹配改成整词边界。** 否决：能修掉 `auth.ts` 一类误伤，但「表演示界面」漏判与同义重复计数仍在，且词表本身覆盖不全的问题不变。

**只注入提示词、由主模型判定。** 否决：判定是否发生取决于模型是否配合，与自动触发的既有结论冲突。

**辅助调用为主 + 主模型兼底（双路）。** 未采用：用户选择了单一路径；实现面更小，且回退到 `l1` 已经保证「判定失败也不会漏掉纪律」。

**把超时回退设为 `l0`。** 否决：模型调用失败时放行请求，等于让基础设施抖动变成纪律缺口；`l1` 的代价只是多一份设计记录。

**保留 60 字 L1 闸门。** 否决：它会在 LLM 判定之前把大量普通请求升为 L1，使 LLM 判定对这部分请求形同虚设。

## 实际交付与设计的差异

设计写的是「回退到 l1 而非 l0」「规则成为可配置提示词」，实现一致。两处实现期修正：

- **长度闸门必须读配置而不是常量。** `gradeByLength` 初版用硬编码 200，忽略了可配置的 `openspecThreshold.descriptionChars`；设置联动测试当场抓到。
- **`ValueField` 原来不支持多行。** 它只渲染 `<input>` 且不应用 `.wide`，卡片传的 `textarea` 被静默忽略——提示词因此会挤在单行输入框里。已为 `ValueField` 补上 `textarea` 支持。

## 影响面

- `packages/delivery/tool-delivery/src/grading.ts` 大幅收缩（词表与匹配函数删除，新增提示词解析）。
- `grading.ts`、`index.ts` 的 `Config`、settings schema、`pre-step` 监听器、`inferLevel`。
- 新增会话事件（辅助调用记录），因此两套 SDK 的期望输出需同步；`GenerateOptions.purpose` 若非新增取值则复用既有机制。
- 客户端 `ui-settings-plugins`：三个标签控件换成一个文本控件，locale 文案同步。
- 测试：`grading.spec.ts` 改写为提示词解析与回退；`tool-delivery.spec.ts` 中依赖词表自动分级的用例改为脚本化辅助模型。
- 文档：`tool-delivery` README、客户端 README、卡片帮助文案、Agent Note；被取代的[自动触发](delivery-discipline-auto-trigger-rationale.zh.md)与[分级复核](../../.agents/notes/implemented/feature/2026-09-15-delivery-grading-review-and-float-card-visibility.zh.md)需交叉更新。
