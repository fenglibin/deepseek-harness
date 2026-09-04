# Agent Note: Turn usage sums a cache bucket over the attempts that reported it

Status: implemented

English | [中文](2026-09-03-turn-usage-sums-disclosed-cache-buckets.zh.md)

## Problem

`deriveTurnTokenUsage` summed each usage bucket with `values.every(isCount) ? safeSum(values) : undefined`. One attempt that omitted `cacheReadTokens` therefore dropped the whole bucket, and the Turn-usage disclosure rendered a cache-hit rate of 0 while the same Turn's footer — which reads the durable `tokenUsage` projection that sums only reported values — showed over 90%. A real session shows the gap: Turn 1 had 30 attempts, step 8 reported `{"inputTokens":34540,"outputTokens":100,"totalTokens":34640}` with no cache bucket, and the disclosure hid 1327616 of 1421880 cached input tokens.

Silence is not a missing measurement for a billing bucket. A provider that reports no cache read is reporting no cache read, and the durable projection already treats it as zero.

## Decision

`aggregateAttempts` sums the two cache buckets over the attempts that did report them and reports the bucket whenever at least one attempt disclosed it (`sumDisclosed` in `packages/llm/token-meter/src/turn-usage.ts`). Reasoning stays all-or-nothing: it is an output subset with no "silent means zero" convention, so a partial sum would read as a real count while understating the Turn. `uncachedInputTokens`, `outputTokens`, and `totalTokens` keep their existing rule, and `totalTokens` still sums only the attempts that reported it. The mirrored `TurnTokenUsage` declaration in `ui-chat`'s Chat contract and both package READMEs state the rule in the same words.

## Alternatives considered

**Treat a silent attempt as an unknown and hide the bucket.** Rejected: it is the shipped behavior and the reported bug. It also disagrees with the durable `tokenUsage` projection the same Turn's footer reads, so the same Turn showed two different cache-hit rates.

**Sum every bucket over reporting attempts, reasoning included.** Rejected: an omitted reasoning count means the attempt did not disclose reasoning, not that it produced none, so the sum would understate output breakdown rather than describe it.

**Drop silent attempts from the Turn entirely.** Rejected: an interrupted or unsampled attempt still consumed input and produced output; the existing state machine already keeps it out of the buckets it did not report and this does not change that.

## Consequences

A Turn whose attempts report cache usage inconsistently now shows a non-zero cache read and write instead of nothing, matching the durable projection and the session footer. A Turn whose every attempt stays silent on a cache bucket still omits it, so no bucket appears that no attempt disclosed.
