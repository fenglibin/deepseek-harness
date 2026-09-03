# Agent 任务执行耗时优化

[English](agent-task-latency.md) | 中文

本文记录一次"删除会话报错"任务的执行耗时剖析、根因结论、分档改造方案与后续任务清单。测量数据取自 `~/Downloads/session.jsonl`（会话 `session-3e506d3f`，2026-09-02）与本机实测命令。结论指导 `docs/design/` 之外的执行顺序：A 档工作方式与编排脚本、B 档运行期配置、C 档工程完成度取舍。

## 一、问题

一个 189 行改动（12 个文件、`packages/api/session-controller` 内新增 `deleteSession`）消耗了 75 个模型往返、95 次工具调用。用户体感为"执行了一个下午"。

### 1.1 时间账单

会话墙钟跨度 1 小时 55 分（17:17:54 创建至 19:12:40 结束），其中 agent 真正在跑的只有一小部分。

| 区间 | 时长 | 性质 |
|---|---|---|
| 会话创建至首个 turn | 1 小时 37 分 | 会话挂着，无输入 |
| 等待用户回复 "OK" | 3.1 分 | 两轮之间 |
| agent 实际执行 | 14.6 分 | 75 步 |
| 其中模型推理与生成 | 12.9 分（88%） | |
| 其中工具执行 | 96 秒（11%） | |

**第一结论：测试不是瓶颈。**工具总耗时 96 秒，其中测试约 20 秒。体感上的"一个下午"主体是等待，不是算力。但 14.6 分钟做 189 行改动仍然偏慢。

### 1.2 步数去向

| 阶段 | 时长 | 步数 | 占比 |
|---|---|---|---|
| turn1 诊断定位 | 4.0 分 | 26 | 27% |
| turn2 A 重新定位代码 | 3.8 分 | 11 | 26% |
| turn2 B 测试、类型、lint、coverage | 1.3 分 | 9 | 9% |
| turn2 C README 双语、i18n、翻译门控 | 1.7 分 | 10 | 12% |
| turn2 D Agent Note 双语、格式门控、收尾验证 | 3.9 分 | 19 | 27% |

纯代码工作（A+B）5.1 分（35%），文档与 Note 仪式（C+D）5.6 分（38%）——仪式比改代码更久。turn1 已完成诊断，turn2 又花 3.8 分钟重读同类文件。

### 1.3 上下文与缓存

- 上下文从 14.5k 单调增长到 105k tokens，累计 `cacheReadTokens` 5.02M。
- 出现 2 次 KV cache 全量失效，重算 29k 与 68k tokens，合计 97k。根因已在 B0 中定位，见第 4.2 节。
- 单次工具输出最大 29,120 字符（一次 grep 命中 250/815 条）。
- `contextWindow` 为 262,144，`compaction-basic` 的 `thresholdRatio` 默认 0.8，即 209k 才压缩。该量级的任务永远触发不了压缩，上下文只增不减。

## 二、测量方法

### 2.1 数据来源

`session.jsonl` 每条记录带 `time`、`seq`、`type` 与 `usage`。按 `seq` 排序后，用 `step/start` 与 `step/end` 求每步墙钟，用 `tool/call` 的 `callId` 匹配 `tool/result` 求每次工具耗时，用 `assistant/message` 的 `usage` 取 `inputTokens`、`cacheReadTokens`、`outputTokens`。

### 2.2 耗时模型

对 75 步的（步耗时，输出 token）做最小二乘拟合：

```text
步耗时 = 4.91s + 15.1ms × 输出tokens
```

- 固定开销：4.91s × 75 步 = **6.1 分（42%）**。每步都要重放当时的完整上下文并走一次调度，与输出多少无关。
- 输出开销：33,779 tokens = **8.5 分（58%）**。
- 输出构成：reasoning 90,538 字符对可见文本 7,331 字符，约 **12 : 1**。

模型时间由"步数"与"reasoning 量"两项主导，各占四成多。上下文大小在有 cache 命中时对步耗时影响不显著，失效时才有代价。

### 2.3 工程侧实测

本机测得（工作区为脏状态，含未提交改动）：

| 命令 | 耗时 | 规模 |
|---|---|---|
| `npx vitest run packages/api/session-controller` | 3.1s | 1 包 |
| `npx vitest run packages/api` | 4.0s | 1 组 |
| `npx vitest run packages/api packages/client/ui-workspace` | 6.2s | 2 组 |
| `npx vitest run`（全量） | 143s | 1060 文件、17,429 用例 |
| `npx tsc -b tsconfig.host.json` 加 tsdown | 12s | 增量 |
| `npx tsx scripts/run-gates.ts doc-quick` | 14.5s | 约 18 个 quick gate |
| `npx vitest run --coverage`（CI 门禁） | 未测出 | CI 该任务 timeout 60 至 120 分 |

agent 全程只跑局部测试（3 至 6 秒），已是自发的最优解。全量单测 143 秒并非 CI 门禁，CI 门禁是 per-file 100% 的 `test:coverage`，本地跑一次需数分钟到十几分钟。

## 三、根因

1. **步数过多**：75 步 × 4.91s 固定开销 = 6.1 分。其中 19 步是单工具串行，16 步输出不足 100 tokens（纯"确认后再调下一个工具"）。
2. **reasoning 过重**：输出 90k 字符思考对 7.3k 字符正文。
3. **工程仪式成本**：双语文档、i18n sidecar、Agent Note 双语、3 类 verify 门控合计 5.6 分，占比超过真正改代码的时间。
4. **重复定位**：turn1 的诊断结论没有以结构化形式（文件:行 加 结论）落进 todo 或 plan，turn2 重读一遍同类文件。
5. **验证调用碎片化**：17 次验证类工具调用（vitest 5、verify 与 gates 5、tsc 2、lint 3、git 5），其中同一包的单测跑了 3 遍，translation-pairing 与 doc-quick 各跑 2 遍。

## 四、方案

按 A 到 B 到 C 的顺序执行。A 档零风险；B 档的 B1、B2 依赖第 1.3 节的 cache 失效根因，未定位前不动；C 档每项都要落到规范文档。

### 4.1 A 档：工作方式与编排脚本

| 编号 | 动作 | 收益 | 风险 |
|---|---|---|---|
| A1 | 本地验证分级：只跑受影响包加其运行时依赖方，全量与 coverage 交 CI。规则落在 `../testing.md` 的「本地验证范围」一节 | 验证从 143s 降到 3 至 6s（单包改动） | 跨包影响漏测，用「包加运行时依赖方」缓解；改基础包时范围仍会放大 |
| A2 | `scripts/verify-changed.ts`：`git diff` 算出受影响包，一次跑完它们的 vitest。`--list` 只列范围，`--direct-only` 去掉依赖方只留直接改动 | 17 次验证调用合并为 1 至 2 次，省约 15 步，约 1.5 至 2.5 分 | 新脚本，纯编排已有命令 |
| A3 | 文档与 Note 一次性收尾：代码与单测先完工，双语文档、i18n、Agent Note 与门控在收尾阶段集中做一遍。规则落在 [`dsh-agent-task-execution`](../../.agents/skills/dsh-agent-task-execution/SKILL.md) | 消除穿插导致的重复定位，实测该项占 38% | 无 |
| A4 | 诊断结论结构化落盘：turn 结束前把「文件:行 加 结论」写进 todo 或 plan，下一 turn 直接消费。规则同上 skill | 省 3 至 4 分的重复定位 | 无 |

### 4.2 B 档：运行期配置

| 编号 | 动作 | 前置 | 风险 |
|---|---|---|---|
| B0 | 定位第 1.3 节 2 次 KV cache 失效的根因 | 无 | 已完成，结论见下 |
| B1 | `compaction-basic.thresholdRatio` 由 0.8 调到 0.5 至 0.6 | B0 | **裁决：不做。** 压缩以 replace 改写历史，每次压缩都开启新请求系列并作废整个前缀缓存，且压缩本身还要一次 LLM 摘要 |
| B2 | `tool-result-pruner.thresholdChars` 由 8192 调到 4096 至 6144 | B0 | **裁决：不做。** 每裁剪一个 tool result 就是一次 replace，调低阈值等于按比例增加全量失效的次数 |
| B3 | `repeat-tool-reminder.thresholds` 由 `[3, 5, 8]` 调到 `[2, 4, 6]` | 无 | 提醒噪音 |
| B4 | 强化并行工具调用引导：多个独立的读、搜、glob 在同一条 assistant 消息里一次性发出，依赖前序结果的调用仍分步。规则落在 [`dsh-agent-task-execution`](../../.agents/skills/dsh-agent-task-execution/SKILL.md) | 省约 11 步的固定开销，约 1 分钟 | 无 |

### 4.2.1 B0 结论：失效来自提供方，而 B1、B2 会主动制造失效

先排除本仓库一侧的前缀变化，再定位真正原因。

**本仓库的前缀是稳定的**，四条证据：

1. `system` 全程静态——`request/header` 记录的系统提示为 6,890 字符，无时间戳、无路径外的动态段。
2. `tools` 全程未变——`request/header` 在整个会话只追加过一次（`reason: initial`），而 `agent.ts` 只有在 `headerEquals` 为假时才记录 `reason: change`，所以工具目录从未改动。
3. 消息是纯追加——会话内 `compaction/prune` 事件数为 0，压缩与裁剪均未触发，`deriveMessages()` 的重建由 `request-reconstruction.spec.ts` 的 THEOREM 用例保证确定性。
4. 失效前后事件序列干净——无重试、无注入、无 replace，相邻两步的上下文总量分别只增长 1,896 与 295 tokens，与相邻正常步同量级。

**失效来自提供方**：两次失效后仅命中 1,152 与 256 tokens，两者都是 64-token 缓存块的整数倍，且远小于系统提示自身的长度，说明只有跨会话共享的公共前缀命中，本会话的历史部分全部未命中。同期 `~/.dsh` 下只有另一个 17:22 结束的会话，与 18:55、19:04 两个失效时刻不重叠，排除会话间争用；相邻请求间隔仅 3 秒内，排除 TTL。最可能的原因是请求被负载均衡到不同的推理节点，或共享 token plan 的缓存池被淘汰。这是外部服务行为，本仓库无法修复。

**但这暴露了 B1、B2 的真实性质**。`packages/core/session/src/surface.ts` 中，每个 `surfaceOp: { op: 'replace' }` 都会把旧事件移出有序 surface，因此 `deriveMessages()` 输出改写后的消息，下一次请求在该点与上一次请求的前缀分叉，其后的提供方 prefix cache 全部未命中。`replaceGeneration` 计数器（以及 `agent.ts` 据此记录的 `startsSeries` 边界）只是把这次改写标记进日志，并非未命中的原因——真正的原因是内容被改写。`tool-result-pruner` 的 `pruneSession` 与 compaction 的替换走的都是这条路。

结论：观测到的 2 次失效是提供方的偶发行为，代价约 97k tokens 重算，按 prefill 吞吐估算占 14.6 分钟的 4% 至 7%，并非主要耗时项；而 B1、B2 一旦实施，会把这种偶发失效变成每次改写历史都必然发生的失效。**当前 0.8 与 8192 的默认阈值反而保护了前缀**——本会话全程未触发压缩与裁剪，正是缓存命中率长期维持在 99% 的原因。

若将来确实需要缩减上下文，正确做法是用只追加的方式（追加一条摘要并把旧节点移出 surface），而不是 replace 历史事件；但按上一段的量化，这项改动当前没有收益。

### 4.3 C 档：工程完成度取舍

| 编号 | 现状 | 改造 | 收益 |
|---|---|---|---|
| C1 | 非平凡变更一律写完整 Agent Note（md、zh、i18n、Alternatives、Consequences）加 2 类 verify | Agent Note 分级，判定标准见下 | D 阶段 19 步降到 8 至 10 步，省约 2 分 |
| C2 | zh 版与 `*.i18n.yaml` 由 agent 手工维护，再跑 `verify-translation-pairing --write` | 英文定稿后，zh 与 i18n 在 PR 阶段批量生成 | C 与 D 再省 30% 至 40% |
| C3 | `doc-quick` 一次 14.5s，本会话跑 2 遍 | 拆为秒级 quick（每次改动跑）与完整 doc-sync（PR 前跑） | 省一次 14.5s 加 1 步往返 |
| C4 | per-file 100% 覆盖率是 CI 门禁 | 本地只跑受影响包的 coverage，全量交 CI | 本地无额外成本，已是现状 |

**C1 的 Agent Note 分级判定标准**，按顺序判定，命中任一即为完整 Note：

1. 改动跨越 `packages/<group>/` 边界。
2. 新增或修改 `SessionEventMap` 成员。
3. 新增或修改 capability seam（Service Definition、Service Provider、Consumer 任一角色）。
4. 触碰 `packages/core/agent-loop`。
5. 改变 model-visible 输入（需新增 session 事件）。

以上全不命中（单包内、无新 seam、无协议与 model-visible 变更）写**精简 Note**，只保留三段：现状、决策、验证。

## 五、影响范围

| 对象 | 影响 |
|---|---|
| `../testing.md`、根 `../AGENTS.md` | A1 写入本地验证分级规则与命令模板 |
| `scripts/verify-changed.ts` | A2 新增 |
| `../../packages/preset/agent-presets/presets/standard/agent.cordis.yml` | B2、B3 的配置改动位置 |
| `../../packages/compaction/compaction-basic/src/config.ts` | B1 默认值改动位置 |
| `.agents/notes/AGENTS.md` | C1 分级标准写入 Agent Note 规则 |
| `../i18n/README.md` | C2 双语产出时机写入配对契约 |
| CI 门禁 | 不受影响。全量、`test:coverage`、`doc-sync` 仍由 CI 拥有，A 到 C 只改本地工作方式 |

## 六、后续任务

按依赖顺序执行，逐项验证：

1. A1 收尾：根 `../AGENTS.md` 已 2737 词、超出 1950 上限，须先按 `docs/AGENTS.md` 的 relocate、condense 顺序精简，再补本地验证分级的链接行。
2. B3、B4 配置与提示改动，各配一条回归验证。
3. 把「replace 会作废前缀缓存」写进 `packages/core/session/README.md` 与 `compaction-basic`、`compaction-tool-result-pruner` 两个包的 README，避免后来者把裁剪或压缩当成无害优化。
4. C1 分级标准写入 `.agents/notes/AGENTS.md`。
5. C2 双语产出时机写入 `../i18n/README.md`，并处理下列待办。
6. C3 `doc-quick` 分层，脚本侧支持。
7. C4 本地 coverage 约定写入 `../testing.md`。
8. 清理 typert generator 的红灯：`schema-emitter.spec.ts` 75 个失败、`type-model.spec.ts` 33 个失败（疑为工作区 `lib/` 产物过期），它是 `.rendered-model-*` 残留目录的来源。
9. 排查 `snapshots/session/repeat-tool-reminder` 快照在本机 45 秒超时：B3 把阈值改为 `[2, 4, 6]` 前后各跑一次对照实验，两次都超时，故为基线问题而非配置引起；需在能跑通该场景的机器上确认真实行为。

双语待办：`docs/gui-polish-standard-mode-rationale.md` 缺中文对应与 i18n sidecar；`docs/event-producer-consumer.md` 的英文已改动但未重新记录配对。两项在本文落地之前就已处于红灯状态。

## 七、未采纳项

| 候选 | 不采纳的原因 |
|---|---|
| 降低 reasoning 强度换速度 | 12:1 的思考正文比是最大单一成本项，但降它等于直接降质量，且需要先选定替代模型。本文记录为后续优化项，待模型选型明确后重启 |
| 探索阶段路由快模型 | 同上，依赖替代模型选型 |
| 改小 per-file 100% 覆盖率阈值 | 该阈值是本仓库质量门禁的核心，CI 拥有；本地成本已通过 C4 与 A1 规避，不需要降阈值 |
| B1、B2 下调压缩与裁剪阈值 | 二者都通过 replace 改写历史，会开启新请求系列并作废整个前缀缓存，把 2.7% 的偶发失效变成每次改写都必然发生的失效，详见第 4.2.1 节 |
| 修改 Lint 配置排除生成物目录 | 约束禁止；生成物目录的正确处理是清理残留，见第 5.1 节 |

## 附：一次 LintBot 误报的处理

`packages/typert/generator/tests/type-model.spec.ts` 用 `mkdtempSync` 创建临时目录 `.rendered-model-*` 渲染类型模型。该套件失败（33 个）后目录残留在工作区，未被 git 跟踪，被 LintBot 扫入并报出 186 个问题（集中在 `client.d.ts`、`external.d.ts`、`host.d.ts`）。

这些文件不是源代码，由测试生成，改动会被下次运行覆盖。处理方式：清理残留目录，不改 Lint 配置，不改渲染器。残留的根因是 typert generator 测试仍为红（`schema-emitter.spec.ts` 75 个失败、`type-model.spec.ts` 33 个失败），需单独排查，大概率是工作区 `lib/` 产物过期。
