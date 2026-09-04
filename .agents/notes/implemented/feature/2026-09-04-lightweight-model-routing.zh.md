# Agent Note: lightweight model routing for auxiliary calls

Status: implemented

[English](2026-09-04-lightweight-model-routing.md) | 中文

## Problem

会话标题来自截断兜底，而不是随发行版组合已经请求的 LLM 标题。抽查本地 12 个会话，每一个都记录了 `session/title-llm-request`，却没有一个记录 `provider` 来源的 `session/title`：辅助请求发起了、失败了，服务层于是保留「取前五个词」的兜底标题。

失败来自路由本身，而不是调用方。默认路由 `tencent-tokenplan / hy4-preview` 对标题请求返回 `finish_reason: length`、`completion_tokens: 64`、`completion_tokens_details.reasoning_tokens: 64`，`content` 为空——整个输出预算都花在思考上，一个字的标题都没产出。`session-title-llm` 把 `max-tokens` 判为错误，因此兜底确定性地生效。

在这条路由上提高上限没有用。128、256、512、1024、2048、4096 全部返回 `finish_reason: length`，`reasoning_tokens` 等于预算上限且 `content` 为空，4096 时耗时 73 秒；抓到的思考正文显示模型在原地复述提示词。该端点上所有关闭思考的手段都被忽略——`enable_thinking: false`、`reasoning_effort: minimal`、`thinking: { type: 'disabled' }`、`thinking: { enabled: false }`、`chat_template_kwargs.enable_thinking`、`extra_body.enable_thinking`——`reasoning_tokens` 始终停在预算上限；系统提示词放在请求体顶层与放进 `messages` 两种情况都试过。

换一条路由就能完成同一件事。`tencent-tokenhub-llm / glm-5.3-flash` 在 `max_tokens: 256`、同样的提示词与输入下，6.8 秒返回 `finish_reason: stop`，思考 228 个 token，正文为 `优化会话标题生成：调用LLM总结用户提问`。由此得到两个事实：64 个输出 token 低于任何思考型路由生成标题所需；一个部署的会话路由可能根本无法胜任辅助请求，而且没有任何可部署的手段让那条路由停止思考。

仓库此前没有留下「轻量任务是否应该使用独立轻量模型」的任何记录——检索 `docs/design/`、`docs/`、`.agents/notes/`（含 `archived/`）均无。

## Decision

`GenerateOptions.purpose` 只有 `'compaction'` 与 `'session-title'` 两个成员，它就是仓库既有的「辅助模型调用」定义，因此轻量路由只服务这两类调用，不扩散到其它地方。

`@deepseek-ai/dsh-lightweight-model` 新增 `lightweight-model` 设置命名空间与 `ctx.lightweightModel` 服务。分区结构为 `{ provider: string, model: string }`，两者默认 `''`；同时为空表示未启用。只给 provider 不给 model 的写入由 `installSection` 的 `validate` 钩子在设置边界拒绝，而不是留给每个消费方各自判断。路由未启用时 `currentSelection()` 返回 `undefined`，因此消费方不需要额外的「是否启用」分支。组合配置项可以给部署一个基础路由，设置文档把用户选择叠加在它上面。

消费方通过 `ctx.get('lightweightModel')` 读取这个可选服务，并把它放在自身显式配置与继承来的会话路由之间：

| 调用方 | 解析顺序 |
|---|---|
| `session-title-llm` | 配置 `provider` + `model` → 轻量模型 → `request/header` 路由 |
| `compaction-basic` | `summarizationProvider` + `summarizationModel` → 轻量模型 → 最新路由请求 → `AgentOptions` |

由于服务是可选的、通过 `ctx.get` 读取，未挂载本包的组合行为与之前完全一致，也没有消费方需要改动自己的 `inject`。

base bundle 把标题调用的 `maxOutputTokens` 从 64 提到 512——高于 `glm-5.3-flash` 实测的 228 个思考 token 并留有空间——并把 `targetCjkCharacters` 从 10 提到 20，以匹配所要求的标题长度。

「设置」→「模型」新增一张轻量模型卡片，从 `session.modelCatalog()` 挑一条路由或清空，实现基于 `packages/client/ui-settings-plugins` 中 subagent 模型选择卡片已有的模式：目录加载、设置域修订号围栏写入、暂存选择/保存/丢弃。设置文档不可写时卡片为只读，且绝不报告一次并未发生的保存。

## Alternatives considered

- **只调大 `maxOutputTokens`** —— 改动最小，但在默认路由上是错的：4096 仍然返回空正文，且每个标题要等 73 秒。
- **新增一个通用的关闭思考开关** —— 该端点能接受的每一种机制都被忽略，这个开关只会是名义上可配置。
- **在 base bundle 里硬编码用户的私有提供方** —— 私有路由属于用户级 `~/.dsh/profiles/*/cordis.patch.yml` 的职责，仓库不随发行版附带此类路由。
- **给 `agent-default-model` 命名空间扩展轻量字段** —— 那个分区是「新 agent 从哪个模型开始」的扁平三字段答案；把辅助路由塞进去会让一份文档承载两个无关的问题。
- **按任务分别配置轻量路由** —— 不作为首个形态；每个消费方已经有自己的 `provider`/`model` 覆盖项且位于共享路由之上，需要按任务区分的部署使用它们即可。

## Consequences

会话模型无法完成辅助请求的部署，现在可以把该请求指向别处；从不设置该路由的部署则保持逐字节一致的行为。`session-title-llm` 与 `compaction-basic` 各自新增了固定「未改变路径」的回归用例与固定新优先级的用例。

代价是被路由到另一个提供方的辅助调用无法复用会话的前缀缓存。这是有意接受的：标题与压缩请求都很小，一条不共享前缀但能跑完的路由，优于一条永远跑不完的路由。

路由本身不做模型能力探测。若用户选中的路由同样无法胜任辅助调用，标题仍然回退——选择权在用户，除文档化的解析顺序外不存在自动回退链。
