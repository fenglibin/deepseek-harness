# 代理工具使用效率：bash 的运行时提示

[English](agent-tool-efficiency.md) | 中文

本文档规定向 `bash` 结果追加的三条窄触发运行时提示，用于把模型导向 harness 已提供的专门工具与事件驱动等待。数据来自 `~/Downloads/session.jsonl`（会话 `session-68379efa`，2 个 turn、389 个 step、112.9 分钟墙钟）。另一会话的剖析见 [agent-task-latency.zh.md](agent-task-latency.zh.md)。

## 1. 问题

一个任务——用 LLM 总结会话标题，外加轻量模型路由卡片——消耗了 389 个 step。仅 `turn 2` 就用了 95.7 分钟、354 个 step。时间花在三类模型行为上，而不是执行缓慢。

| 行为 | 证据 | 未被使用的既有能力 |
|---|---|---|
| 用 `bash` 而非专门工具做搜索与浏览 | `grep` 出现在 85 条命令中，`sed` 44、`ls` 32、`cat` 15、`find` 15；`fs_search` 工具被调用 **0 次** | `tool-fs-search` |
| 用固定 `sleep` 轮询而非事件驱动等待 | 5 次 `sleep`（90/240/300/300/240 秒）共 19.5 分钟；最慢的 5 个 step 全是 `sleep`；另有 `list_agents` 14 次、`job_output` 20 次轮询调用 | `job_output` 的 `wait: true`（[tool-jobs](../../packages/jobs/tool-jobs/src/index.ts)）与完成通知 |
| 反复探测而不询问 | `python3` 25 条命令；探测约 20 分钟后才调用一次 `ask_user_question` | `ask_user_question` |

三者的共同点是：**能力已经存在，只是没被使用。**这正是修复落在运行时提示、而非新增机制的原因。

### 1.1 什么不是问题

两个看似严峻的测量结果属于假象，不得据此开展工作了：

- **命令重复可忽略。**242 次 `bash` 调用中 **237 条各不相同**，仅 5 条重复。命令去重提示几乎不会触发。
- **`tool/call` → `tool/result` 的耗时不是工具执行时间。**它包含模型生成下一步的时间。据此得出 `read` 平均 190 秒、`bash` 平均 49 秒，对真实工作而言都不可能。只有 step 级计时与天然计时的命令（`sleep`）可信。

### 1.2 `sleep` 的代价在轮询方式，不在等待本身

5 次 `sleep` 落在 86.3 分钟到 105 分钟之间，等待的子代理 `68712351` 大约从 80 分钟运行到 108.9 分钟。等待本身大多是必要的。浪费的是**形式**：

- 固定 `sleep` 总是耗尽整段时长，即便任务几秒后就结束；`job_output` 的 `wait: true` 在任务落定那一刻即返回。
- 每次 `sleep` 加随后的检查都消耗一个 step，而每个 step 都要付一次固定的调度往返。

因此可回收的成本是那 34 次轮询调用与多等的时长，而非完整的 19.5 分钟。

## 2. 为什么仅靠提示词引导不够

[tool-jobs](../../packages/jobs/tool-jobs/src/index.ts) 已经注册了这段系统提示：

```text
You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work.
```

该会话表明这段引导存在但被忽略：模型照样睡了五次，而它被告知可依赖的完成通知其实已送达（日志中出现多条 `background job … finished` 与 `Background subagent … finished`）。一条只在开头陈述一次、远离行动时刻的通用规则，在这里不改变行为。下面的提示**在恰好表现出该模式的那次调用的结果中触发**，这正是本设计所依赖的差异。

## 3. 方案

新增一个导出的纯函数，并由 `bash` 结果渲染器调用。三条提示各有刻意收窄的触发条件。这里不改变工具的 output schema；提示是渲染器追加的文本，因此 canonical value、快照与线上契约均不受影响。

### 3.1 提示挂载的位置

[`render.ts`](../../packages/shell/tool-bash/src/render.ts) 在 `renderResult` 中拥有面向模型的文本。其 markers 数组以 exit marker 结尾，而 `parseExitStatus` 锚定在那里，因此**提示必须插在 exit marker 之前，绝不能追加在其后**。

具体做法：

1. 在 [`render.ts`](../../packages/shell/tool-bash/src/render.ts) 增加 `export function efficiencyHints(command: string): readonly string[]`。它是纯函数：同样的命令进，同样的提示出。
2. 将 `renderResult` 扩展为 `renderResult(result, escalationModes, command = '')` 接收命令，调用 `efficiencyHints`，并把返回的 markers 在 `timedOut` / signal / exit-code 块**之前**压入 `markers`。
3. 在 [`index.ts`](../../packages/shell/tool-bash/src/index.ts) 的调用点传入命令，那里的 `render` 已经能拿到 `args`。

242 次调用中有 234 次的命令形如 `cd <路径> && <真实命令>`，因此匹配器在测试前先剥去一个前导的 `cd <路径> &&`。

### 3.2 提示 1 —— 用 `sleep` 而非事件驱动等待

- **触发**：剥离后的命令包含 `sleep <n>` 且 `n >= 30`。
- **文案**：`[hint: to wait on a background job, call job_output with wait: true and timeout_ms; it returns the moment the job settles, instead of sleeping a fixed duration]`
- **窄度**：在剖析会话中命中 5 次。就单次触发的价值而言这是最高的一条。

### 3.3 提示 2 —— 通过 `bash` 搜索或浏览

- **触发**：剥离后的命令以 `grep` 或 `find` 开头（作为首词分别命中 53 次和 9 次）。管道中的 `grep`（`| grep`）**不算**——它是在过滤另一条命令的输出，专门工具无法替代。
- **文案**：`[hint: code search through the fs_search tool is structured and avoids shell quoting; prefer it over grep/find for locating code]`
- **窄度**：约 62 次命中，是最大的一类，因此尽管触发相对宽一些仍值得加提示。

### 3.4 提示 3 —— 全仓库验证

- **触发**：剥离后的命令包含 `--coverage`，或匹配 `pnpm (run )?test` / `npx vitest run` **且不带路径参数**（裸跑会扫全仓库）。
- **文案**：`[hint: this runs the whole repository suite (measured ~143 s for 17,429 tests); scope it to the affected packages — see docs/testing.md]`
- **窄度**：仅在未限定范围的验证时触发。带范围的跑法如 `npx vitest run packages/api` 不得触发。

### 3.5 明确不在范围内

- **不做命令去重提示。**242 次调用中仅 5 次重复，且 `repeat-tool-reminder` 已经在管（本会话触发 2 次）。
- **不为 `cat`、`sed`、`ls` 加提示。**`sed` 的次数主要来自编辑，那是 `edit` 无法机械表达的；加提示对错参半。
- **不改 `job_output`**、`tool-jobs` 或任何引导文本。能力本身是对的，缺的是在使用当刻被发现。

## 4. 风险

| 风险 | 评估 |
|---|---|
| 转录中的提示噪声 | 受窄触发约束：242 次调用中约 70 次，每次一行。所有者正是为此选择窄触发而非宽触发。 |
| 提示误伤合法命令 | 提示 3 可能对一次有意的全量跑触发。文案陈述代价而非禁止命令，因此有意的跑法照常进行。 |
| 破坏 `parseExitStatus` | 若把提示追加在 exit marker 之后就会真实发生。3.1 节把插入顺序列为明确要求，并用测试断言：存在提示时 `parseExitStatus` 仍能找到 exit marker。 |
| 快照波动 | 提示改变了 `bash` 结果中模型可见的文本。任何输入含触发命令的快照都需要重录。 |
| `grep` 过度触发 | 已通过排除管道 `grep` 缓解。若日后测量显示噪声偏大，可进一步收窄到仅递归形式（`grep -r`）。 |

## 5. 验证

由所有者在真实任务上手工验证；本文档不规定自动化基准。针对每条提示确认：

1. 命中触发的命令，其结果文本包含提示，且 exit marker 仍排在最后。
2. 近似但不命中的输入**不**触发：`sleep 5`、`some-command | grep x`、`npx vitest run packages/api` 各自产生未改动的文本。
3. `parseExitStatus` 能从带提示的结果中解析出 exit code。

单元测试覆盖纯匹配函数与顺序保证：

- `efficiencyHints` 对命中命令返回对应提示，对上述近似输入返回 `[]`。
- `renderResult` 带提示时仍把 `[exit code: N]` 保持在最后一个 marker。
- 匹配前已剥去 `cd <路径> &&` 前缀。

## 6. 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 运行时提示还是系统提示引导 | 运行时提示。同一主题的提示引导已存在且被忽略（第 2 节）。 |
| 2 | 是否改 schema 承载提示 | 否。提示以文本渲染，canonical value 与线上契约保持不变。 |
| 3 | 命令去重提示 | 否：242 次调用仅 5 次重复，且 `repeat-tool-reminder` 已覆盖。 |
| 4 | 按 `tool/call` → `tool/result` 耗时做去重 | 否：该区间含模型生成时间，不是工具成本（第 1.1 节）。 |
| 5 | 触发宽窄 | 窄，依所有者决定：提示只在其所指明的特定模式上触发。 |
