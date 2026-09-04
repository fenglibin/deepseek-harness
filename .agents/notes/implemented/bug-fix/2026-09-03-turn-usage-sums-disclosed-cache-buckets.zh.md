# Agent Note: 轮次用量按已上报该分桶的 attempt 求和

Status: implemented

[English](2026-09-03-turn-usage-sums-disclosed-cache-buckets.md) | 中文

## Problem

`deriveTurnTokenUsage` 过去用 `values.every(isCount) ? safeSum(values) : undefined` 对每个用量子桶求和。因此只要有一个 attempt 没有上报 `cacheReadTokens`，整个分桶就会被丢弃，轮次用量披露显示缓存命中率为 0，而同一轮次的底部统计——它读取的是只对已上报值求和的持久化 `tokenUsage` projection——却显示超过 90%。一个真实会话可以复现该差距：第 1 轮有 30 个 attempt，其中第 8 步上报的是 `{"inputTokens":34540,"outputTokens":100,"totalTokens":34640}`，不含任何缓存分桶，于是披露隐藏了 1421880 个缓存输入 token 中的 1327616 个。

对于计费分桶而言，沉默并不代表"没测到"。提供方没有上报缓存读取，就是在上报"没有缓存读取"，而持久化 projection 早已把它当作 0。

## Decision

`aggregateAttempts` 现在对两个缓存分桶只在上报了它们的 attempt 上求和，并且只要至少有一个 attempt 披露了该分桶，就给出该分桶（`packages/llm/token-meter/src/turn-usage.ts` 中的 `sumDisclosed`）。reasoning 仍保持"全有或全无"：它是输出的子集，没有"沉默即零"的约定，因此部分求和会被误读为真实计数，反而低估该轮次。`uncachedInputTokens`、`outputTokens` 与 `totalTokens` 沿用原有规则，`totalTokens` 仍只对上报了它的 attempt 求和。`ui-chat` Chat 契约中镜像的 `TurnTokenUsage` 声明以及两份包 README 用同样的措辞陈述了该规则。

## Alternatives considered

**把沉默的 attempt 视为未知并隐藏该分桶。** 否决：这正是已发布的行为，也就是所报告的 bug。它还与同一轮次底部读取的持久化 `tokenUsage` projection 不一致，导致同一轮次出现两个不同的缓存命中率。

**对每个分桶都按已上报的 attempt 求和，包括 reasoning。** 否决：省略 reasoning 计数意味着该 attempt 没有披露 reasoning，而不是它没有产生 reasoning，因此求和会低估输出构成，而不是描述它。

**直接把沉默的 attempt 从轮次中剔除。** 否决：一个被打断或没采到样的大模型 attempt 仍然消耗了输入并产出了输出；现有状态机已经把它排除在它没有上报的分桶之外，本次改动并不改变这一点。

## Consequences

attempt 上报缓存用量不一致的轮次现在会显示非零的缓存读取与写入，而不是什么都不显示，与持久化 projection 和会话底部统计一致。所有 attempt 都没有上报某个缓存分桶的轮次仍然省略该分桶，因此不会出现没有任何 attempt 披露过的分桶。
