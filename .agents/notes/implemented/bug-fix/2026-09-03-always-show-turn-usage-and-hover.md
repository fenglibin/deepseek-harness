# Agent Note: Per-turn token usage and time always disclose, with hover dialogs, a cache-hit share, and a stable running clock

Status: implemented

English | [中文](2026-09-03-always-show-turn-usage-and-hover.zh.md)

## Problem

A completed Turn's tail disclosed its token usage only when the token-meter fold could prove an exact total. `deriveTurnTokenUsage` closed an attempt only when its usage sample carried a `totalTokens`, or both `cacheReadTokens` and `cacheWriteTokens`; DeepSeek reports no cache-write bucket, and sessions recorded before the adapter began emitting `totalTokens` therefore failed the fold. A turn interrupted (user stop or system abort) discarded every billed attempt the moment one attempt closed without a usage sample, so aborted multi-step turns showed `Ran for …` but no `Usage … tok` pill. Separately, the two stat dialogs opened only on click, the cache-hit share appeared only when every attempt reported `cacheReadTokens`, and the running "Deep diving" clock fell back to component mount time when `turn/start` was outside the loaded window, so switching sessions and back restarted the clock.

## Decision

`normalizeUsage` derives the exact total as billed prompt plus output (`inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`) whenever the provider omits `totalTokens`, treating an absent cache bucket as zero — the same convention the cumulative `tokenUsage` projection already applies. An attempt that reported a usage sample must still close with safe counts and an exact total, but an attempt interrupted before reporting any usage is skipped, so a turn's remaining billed attempts disclose. The usage and time pills render for every completed Turn whose fold carries a billed attempt. The usage and time dialogs open on hover (mouse enter) and close after the pointer grace on leave; click remains for keyboard and touch. The usage dialog always shows the cache-hit share (`cacheReadTokens ?? 0`). The running clock anchors to `turn/start`; when that boundary is outside the window there is no stable anchor, so the clock is omitted instead of restarting from mount time.

## Alternatives considered

**Keep click-open dialogs.** Rejected: the dialogs are diagnostic surfaces the user hovers over; a click adds a step without adding precision.

**Leave the cache-hit row conditional.** Rejected: the session StatsLine already always shows a cache-hit share, so the per-Turn dialog omitting it was an unexplained asymmetry.

**Keep the exact-total requirement.** Rejected: a provider without a cache-write bucket bills `input + cacheRead + output` exactly, so treating a missing bucket as zero is the complete bill, not a lower bound.

**Fail the whole turn when any attempt is interrupted.** Rejected: a user stop or transient failure should still disclose the attempts that did bill; only a contradictory usage sample (not a missing one) invalidates the fold.

**Anchor the running clock to mount time when `turn/start` is outside the window.** Rejected: mount time resets on every re-entry, so the clock restarted; omitting the clock is honest where the true elapsed time is unknown.

## Consequences

`deriveTurnTokenUsage` now derives totals for providers that omit `totalTokens` and/or `cacheWriteTokens` and keeps billed attempts across an interrupted step, so the turn-tail usage pill appears on previously silent sessions (including aborted and failed turns with at least one billed attempt). The hover open/close and always-on cache-hit share apply to both the usage and time pills through the shared `useStatDialog`. The running "Deep diving" clock no longer restarts on session re-entry: it anchors to `turn/start` and is omitted when that boundary is paged out. Keyless recorded-session goldens that seed turns with usage but no `totalTokens`, or that interrupt a step, now show the `Usage … tok` pill and must be regenerated with `pnpm run test:web:refresh`.
