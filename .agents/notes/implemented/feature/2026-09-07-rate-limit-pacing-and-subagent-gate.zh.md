# Agent Note: 限流节奏与子 agent 闩锁

Status: implemented

## Problem

提供方返回 HTTP 429（`RATE_LIMIT`）说明调用方已撞上一条请求速率或并发配额窗口。逐提供方重试策略（见[逐提供方请求重试策略](2026-07-24-provider-retry-policies.zh.md)）默认把 `RATE_LIMIT` 当作普通瞬态错误，用 500 毫秒起步的指数退避重试：下一次尝试几乎必然落在同一个尚未关闭的窗口里，既烧掉重试预算，又放大对已限流路由的并发。同一时刻，agent 仍可能委派子 agent——每一路子 agent 都是朝同一条被限流路由新增的并发请求流，把一次 429 恶化成持续的请求风暴。二者需要在同一个提供方策略与同一个 Session 生命周期内被协同压制。

## Decision

`BackoffConfig` 新增 `rateLimitDelayMs`（默认 30 秒）：`RATE_LIMIT` 失败不再套用指数退避，改等这一固定时长——一个限流意味着一个配额窗口，更短的等待只会把下一次尝试投进刚被拒绝的窗口。提供方给出更长窗口的 `Retry-After` 仍然生效；两者都不受 `maxDelayMs` 封顶，但一个超过 `max(maxDelayMs, rateLimitDelayMs)` 的提供方指令会让 normal 模式委托后续处理、让 always 模式回退到 `rateLimitDelayMs`。`rateLimitDelayMs` 进入已解析策略的规范键，因此只改这一字段也会让重试历史重新开始。

`@deepseek-ai/dsh-llm-retry` 新增一个仅宿主的 Session 投影单元 `llmRateLimit`，把日志里的限流历史折叠成单一闩锁：一次被安排的 `llm/retry`（其 `failure.code === 'RATE_LIMIT'`）或一次以 `RATE_LIMIT` 收尾的 `turn/end` 都会把闩锁置真，此后不再复位。两者都持久，因此闩锁在冷恢复后仍然生效，且无需任何存活状态。插件导出 `isRateLimited(ctx, session)` 作为读取入口；该投影属于 `dsh-llm-retry`，所以未挂载本插件的组合读到 `undefined` 并判定为「未限流」。

`@deepseek-ai/dsh-tool-subagent` 在委派执行前通过 `rateLimitedDelegation` 读取调用 agent 所在 Session 的闩锁，并沿其 live 直接父 Session 再查一层：一个子 agent 的父 Session 已限流时，子 agent 也不得再开孙子 agent——限流是账号级的，孙子会把祖先刚触发的并发风暴继续放大。只有直接 live 父被检查：离线的父无法读取，更深的祖先是 gate 已停止增长的在途并发。一旦判定限流，工具抛出错误并把「请在本对话中直接完成工作」的指引交给模型。这使 `dsh-tool-subagent` 依赖 `@deepseek-ai/dsh-llm-retry`（新增 peer/dev 依赖与项目引用）。

## Alternatives considered

**在 agent loop 或 `ctx.subagents` 服务里关门**：不予采纳。循环层应保持「加插件，不改 loop」的边界；在 `SubagentRuntime.start` 里关门会要求 Service Definition 依赖重试执行器，反向耦合比让模型面向的消费者读取一个宿主投影更重。

**新增一条 `llm/rate-limited` Session 事件记录限流**：不予采纳。现成的 `llm/retry`（已安排的限流重试）与 `turn/end` 的终止 `error` 已完整覆盖每条到达循环的 429，无需再改事件词汇表、持久化目录与 SDK 期望输出。折一个事件子集来驱动投影，代价更低且语义一致。

**把 30 秒直接写死进执行器**：不予采纳。随部署变化的可调项必须是从 cordis.yml 可改的经校验 `Config` 字段，而不是常量。

**限流延迟套用 `maxDelayMs` 封顶**：不予采纳。默认 `maxDelayMs` 是 10 秒，封顶会把 30 秒等待压回一个几乎必然仍处限流的窗口，正好抵消本决策的目的。

## Consequences

命中 429 的请求现在至少等待 30 秒才重试，因此从短暂限流中恢复不再消耗指数退避预算；代价是正常模式下遇到持续限流时，恢复节奏比原先更慢。Session 一旦限流，其后续委派全部被关停，模型被明确指引回到本对话完成工作，避免在同一 Session 内放大对已限流路由的并发；该闩锁随 Session 持久，直到 Session 结束。`dsh-tool-subagent` 因此新增了对 `dsh-llm-retry` 的依赖，而「未挂载 `dsh-llm-retry`」的组合既不重试限流、也不关停委派——两者作为同一个可选能力一起开关。
