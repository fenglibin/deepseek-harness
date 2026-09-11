# Agent Note: 把 pi-ai 畸形 SSE 载荷归类为可重试的 TRANSPORT

Status: implemented

## 问题

一次任务运行时页面报「本轮运行失败 Unexpected token 'd', "data: {"id"... is not valid JSON」，控制台同时浮现 `Could not parse message into JSON: data: {…}` 与 `From chunk: ['data:data: {…}']`。根因是上游网关（如 Venus 平台）在转发带思维链的流式响应时，个别 SSE 行的 `data:` 前缀被重复写成 `data:data:`：openai SDK 的 `SSEDecoder` 按第一个冒号分割，于是字段值仍残留 `data: {…}`，`JSON.parse` 因此失败。

pi-ai 把这个 `SyntaxError` 折叠成流内的 `error` 事件（`errorMessage` 只剩 `Unexpected token … is not valid JSON`），而 `dsh-llm-pi-ai` 的 `classifyPiAiError` 对这种措辞一个都不匹配，落入兜底的 `PI_AI_ERROR`。由于 `PI_AI_ERROR` 不在 `llm-retry` 的 `DEFAULT_RETRYABLE_CODES`（`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`）里，一次可恢复的畸形帧被当作永久失败，任务从未重试就终止了。

同一次改动还暴露出上一提交在 `adapter.ts` 里引入的另一个缺陷：它把裸 SDK 抛错统一包装成 `LlmError('TRANSPORT')`，但没有区分「派发前的本地失败」与「流消费中的传输失败」，于是 `toPiContext` 这类 pre-dispatch 的裸错误也被错误地改成 `TRANSPORT`，破坏了 `preserves an unknown pre-dispatch adapter Error exactly` 所锁定的「原样保留」语义。

## 决策

- `classifyPiAiError` 增加一类 JSON 解析失败的措辞匹配，统一映射为 `TRANSPORT`：`unexpected token`、`unexpected end of JSON input`、`unexpected non-whitespace character after JSON`、`is not valid JSON`、`malformed JSON`、`invalid JSON`。畸形帧是传输层损坏而非模型失败——下一次尝试完全可能读到一帧格式完好的数据，因此可重试。
- `adapter.ts` 的 `streamWithSnapshot` 用一个 `iterating` 布尔标记流消费是否已经开始：只有 `iterating === true` 之后的裸 SDK 抛错才包装成 `TRANSPORT`；此前的裸抛错（context 转换等 pre-dispatch 失败）仍原样抛出，保留本地失败的语义。`LlmError` 依旧原样穿透，超时与调用方取消的分类优先于该包装。

两处协同才覆盖完整链路：`classifyPiAiError` 修复了 pi-ai 以「流内 error 事件」投递的畸形响应（用户实际踩到的路径），`iterating` 修复了上一提交对「裸抛错」路径的过度包装。

## 考虑过的替代方案

**把 JSON 解析失败保留为 `PI_AI_ERROR`，同时放宽 `llm-retry` 的可重试集合。** 否决：`PI_AI_ERROR` 是真正未分类失败的兜底，其中混着不可重试的失败（畸形的提供方响应、意料之外的 SDK bug）。让兜底整体可重试会反复重试永远无法成功的失败；正确做法是分类出可恢复的那一种，而不是模糊这个类别——与 `2026-07-22-pi-ai-transport-truncation-classification.zh.md` 的取舍一致。

**在 adapter 层拦截原始响应字节流，就地修复 `data:data:` 前缀。** 否决：pi-ai 的 `SimpleStreamOptions` 不暴露 fetch/dispatcher/client 钩子，适配器看到错误时原始字节早已被 openai SDK 消费并折叠成 `errorMessage`，没有可拦截的边界。分类出 `code` 是唯一还能增加的价值。

**仿照 `llm-deepseek` 把畸形载荷归类为 `MALFORMED_RESPONSE`。** 否决：`MALFORMED_RESPONSE` 同样不在默认可重试集合里，需要额外改 `retry-policy`；而 pi-ai 的传输层措辞（`terminated`、`stream ended before/without`）历来都归 `TRANSPORT`，把畸形帧也归 `TRANSPORT` 才能与既有分类语义对齐，避免两个适配器对同一类传输层异常给出不同的可重试 code。

## 后果

- 畸形 SSE 载荷现在携带 `TRANSPORT`，组合出的 `llm-retry` 策略会默认重试它，而不是让该轮次失败。
- adapter 层的 pre-dispatch 裸错误恢复了「原样保留」的语义，`preserves an unknown pre-dispatch adapter Error exactly` 与 `lets a concurrent caller abort classify a pre-dispatch adapter failure` 继续成立。
- 分类仍依赖字符串匹配且依赖提供方措辞：未来某个 pi-ai 版本若改写 `JSON.parse` 失败的错误文案，会静默回退到 `PI_AI_ERROR`，直到模式被更新。`classifyPiAiError` 上方的 `XXX(pi-ai upstream)` 注记仍指向那个持久的修复方式（基于转发的 `code`/`cause` 路由）。
- 通知文本不变（`Unexpected token … is not valid JSON`）：cause 细节在适配器看到之前就已被 pi-ai 扁平化，只有被路由的 `code` 得到改善。
