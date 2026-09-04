# Agent Note: bash 结果携带指向未使用能力的运行时提示

Status: implemented

[English](2026-09-04-bash-result-efficiency-hints.md) | 中文

## Problem

一次剖析会话（`session-68379efa`，2 个 turn、389 个 step、112.9 分钟墙钟）的耗时来自模型行为而非执行缓慢：用 `bash` 搜索（`grep` 出现在 85 条命令中、`find` 15 条，而 `fs_search` 工具被调用 0 次）；用 5 次 90–300 秒的固定 `sleep` 等待，而不是 `job_output` 的 `wait: true`；探测约 20 分钟后才调用 `ask_user_question`。模型所需的每一种能力都已存在。

[tool-jobs](../../../../packages/jobs/tool-jobs/src/index.ts) 早已在系统提示中写了不要轮询任务，该会话照样忽略：模型睡了五次，而它被告知可以依赖的完成通知其实正在送达。只在会话开头陈述一次的引导，无法与调用当刻的直觉竞争，因此修复必须落在**表现出该模式的那次调用的结果**里。测量数据及其被排除的解读见[设计文档](../../../../docs/design/agent-tool-efficiency.zh.md)。

## Decision

[render.ts](../../../../packages/shell/tool-bash/src/render.ts) 的 `renderResult` 把导出的纯函数 `efficiencyHints(command)` 返回的行，追加在超时/信号/退出标记之前。三条触发条件，每一条都刻意收窄：

| 触发 | 命令满足 | 导向 |
|---|---|---|
| 固定等待 | 包含 `sleep <n>` 且 `n >= 30` 秒 | `job_output` 的 `wait: true` 与 `timeout_ms`，它在任务落定那一刻返回 |
| shell 搜索 | 剥离前缀后以 `grep` 或 `find` 开头 | `fs_search`，无需 shell 引号转义 |
| 全仓库验证 | 包含 `--coverage`，或匹配 `pnpm [run] test…` / `npx vitest run` —— 两种情况都仅在没有任何 token 看起来像路径或文件参数时触发 | 把范围限定到受影响的包 |

scope 排除同样约束 `--coverage`，而不仅是测试跑法模式：设计 §3.4 说该触发「只在未限定范围的验证时触发」，因此 `npx vitest run packages/api --coverage` 即使包含 `--coverage` 也不得触发——「包含 `--coverage`」这条字面触发按此规则解读。

匹配前先剥去前导的 `cd <path> &&`，因为 242 次测量调用中有 234 次是模型这样包装的。管道中的 `grep` 不算：它过滤的是另一条命令的输出，任何搜索工具都无法替代。两条提示所指的工具在每个挂载 bash 工具的 preset 中都已装载，因此没有提示会指向不存在的工具。

组合依赖的两条不变式：

- **提示排在退出标记之前。** `parseExitStatus` 锚定在最后一行，terminal 卡片的退出 pill 由它解析，因此把提示追加在标记之后会让每条带提示的结果静默丢失 pill。
- **`efficiencyHints` 是命令的纯函数。** 不查注册表、不依赖插件加载顺序，因此回放与实时调用渲染出完全相同的文本。

提示文案陈述代价而不是禁止命令，因此一次有意的全仓库跑法照常进行。

## Alternatives considered

**只用系统提示引导。** 被拒绝：这正是任务轮询的现状，而剖析会话忽略了它。

**用工具 output schema 承载提示。** 被拒绝：schema 字段是线上与快照契约，而这些提示只是呈现文本；以文本渲染可以让 canonical value、已持久化的快照与 wire 全部保持不变。

**命令去重提示。** 被拒绝：242 次调用中仅 5 次重复，且 `repeat-tool-reminder` 已经在管。

**按运行时工具可用性开关提示。** 被拒绝：在 `render` 里查注册表会让其输出依赖插件加载顺序，而每个挂载 bash 工具的组合本来就同时装载了提示所指的两个工具。

**解析 `sleep` 后缀（如 `sleep 1m`）。** 暂缓：实测的等待全部是裸秒数，macOS 的 `sleep` 不接受后缀，而支持它要为一种罕见形式多付一条兜底路径。带后缀的等待是漏掉的提示，绝不是错误的提示。

**为 `cat`、`sed`、`ls` 加提示。** 被拒绝：`sed` 的次数主要来自 `edit` 无法表达的编辑，提示对错参半。

## Consequences

242 次测量调用中约 70 次会多一行，其余与之前逐字节相同。提示是保留在 transcript 中的文本，因此在压缩（compaction）前一直占用输入 token，但它位于可复用的请求前缀之后，KV Cache 复用不受影响。

提示 3 引用了[耗时剖析](../../../../docs/design/agent-task-latency.zh.md)中的一次实测代价（17,429 个测试约 143 秒）；该数字会随套件增长而漂移，它是量级证据而不是实时测量。

`dsh-tool-pwsh` 不带提示。它的 renderer 是 bash 版本刻意保持的孪生实现，但每条触发条件都指向 Unix 命令（`grep`、`find`、`sleep`）或本仓库的 `pnpm`/`vitest` 惯用法，这些在 PowerShell 路径上都不存在。

验证：[render-hints.spec.ts](../../../../packages/shell/tool-bash/tests/render-hints.spec.ts) 锁定匹配器、近似未命中、`cd` 剥离，以及「退出标记保持在最后」的顺序保证；[tools.spec.ts](../../../../packages/shell/tool-bash/tests/tools.spec.ts) 通过真实工具执行一次命中命令，断言提示进入模型可见文本，并断言后台启动确认文本不带提示。提示能否在真实任务上改变模型行为，仍是单元测试无法做出的所有者判断。
