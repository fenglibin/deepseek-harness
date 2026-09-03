# Agent task latency optimization

English | [中文](agent-task-latency.zh.md)

This document records a latency profile of one "session delete failed" task, its root causes, the tiered remediation plan, and the follow-up task list. Measurements come from `~/Downloads/session.jsonl` (session `session-3e506d3f`, 2026-09-02) and commands timed on this machine. The conclusions drive the execution order outside `docs/design/`: tier A working methods and an orchestration script, tier B runtime configuration, and tier C engineering-completeness trade-offs.

## 1. The problem

A 189-line change (12 files, adding `deleteSession` inside `packages/api/session-controller`) consumed 75 model round trips and 95 tool calls. It felt like "an entire afternoon".

### 1.1 The time ledger

The session spans 1 hour 55 minutes of wall clock (created 17:17:54, ended 19:12:40). The agent actually ran for only a fraction of it.

| Interval | Duration | Nature |
|---|---|---|
| Session creation to first turn | 1 h 37 min | Session open, no input |
| Waiting for the user's "OK" | 3.1 min | Between turns |
| Agent execution | 14.6 min | 75 steps |
| Of that, model inference and generation | 12.9 min (88%) | |
| Of that, tool execution | 96 s (11%) | |

**First conclusion: tests are not the bottleneck.** Tools account for 96 seconds in total, of which tests take about 20 seconds. The felt "afternoon" is mostly waiting, not compute. Even so, 14.6 minutes for 189 lines is slow.

### 1.2 Where the steps go

| Phase | Duration | Steps | Share |
|---|---|---|---|
| turn1 diagnosis | 4.0 min | 26 | 27% |
| turn2 A re-locating the code | 3.8 min | 11 | 26% |
| turn2 B tests, types, lint, coverage | 1.3 min | 9 | 9% |
| turn2 C README bilingual, i18n, pairing gate | 1.7 min | 10 | 12% |
| turn2 D Agent Note bilingual, format gate, final verification | 3.9 min | 19 | 27% |

Pure code work (A+B) is 5.1 min (35%); documentation and Note ceremony (C+D) is 5.6 min (38%) — the ceremony costs more than the code change. turn1 finished the diagnosis, then turn2 spent 3.8 minutes re-reading the same class of files.

### 1.3 Context and cache

- Context grows monotonically from 14.5k to 105k tokens, with 5.02M accumulated `cacheReadTokens`.
- Two full KV cache invalidations recompute 29k and 68k tokens, 97k in total. The cause is not yet located; it blocks tier B.
- The largest single tool output is 29,120 characters (one grep matching 250 of 815).
- `contextWindow` is 262,144 and `compaction-basic` defaults `thresholdRatio` to 0.8, so compaction starts at 209k. A task of this size never triggers it, and context only grows.

## 2. Measurement method

### 2.1 Data source

Every `session.jsonl` record carries `time`, `seq`, `type`, and `usage`. Sorting by `seq`, each step's wall clock comes from `step/start` and `step/end`; each tool's duration comes from matching `tool/call` to `tool/result` by `callId`; token counts come from `inputTokens`, `cacheReadTokens`, and `outputTokens` on `assistant/message`.

### 2.2 The duration model

Least-squares fit over 75 steps of (step duration, output tokens):

```text
步耗时 = 4.91s + 15.1ms × 输出tokens
```

- Fixed cost: 4.91s × 75 steps = **6.1 min (42%)**. Every step replays the full context of that moment and pays one scheduling round trip, independent of output size.
- Output cost: 33,779 tokens = **8.5 min (58%)**.
- Output composition: 90,538 characters of reasoning against 7,331 characters of visible text, about **12 : 1**.

Step count and reasoning volume dominate model time, each contributing over 40%. Context size barely affects step duration while cache hits hold; it only costs when the cache breaks.

### 2.3 Measured on this machine

Timed on a dirty worktree with uncommitted changes:

| Command | Duration | Scale |
|---|---|---|
| `npx vitest run packages/api/session-controller` | 3.1s | 1 package |
| `npx vitest run packages/api` | 4.0s | 1 group |
| `npx vitest run packages/api packages/client/ui-workspace` | 6.2s | 2 groups |
| `npx vitest run` (full) | 143s | 1060 files, 17,429 tests |
| `npx tsc -b tsconfig.host.json` plus tsdown | 12s | incremental |
| `npx tsx scripts/run-gates.ts doc-quick` | 14.5s | about 18 quick gates |
| `npx vitest run --coverage` (CI gate) | not measured | CI gives that job a 60 to 120 min timeout |

The agent ran only targeted tests (3 to 6 seconds) throughout, already the spontaneous optimum. The 143-second full suite is not the CI gate; the gate is `test:coverage` at per-file 100%, which takes minutes to tens of minutes locally.

## 3. Root causes

1. **Too many steps**: 75 steps × 4.91s fixed cost = 6.1 min. Of them, 19 steps issue a single serial tool call and 16 steps emit fewer than 100 tokens — pure "confirm, then call the next tool".
2. **Heavy reasoning**: 90k characters of thinking against 7.3k characters of prose.
3. **Engineering ceremony cost**: bilingual docs, i18n sidecars, bilingual Agent Notes, and three verify gates total 5.6 min, more than the code change itself.
4. **Repeated location**: turn1's diagnosis never landed as structured findings (file:line plus conclusion) in a todo or plan, so turn2 re-read the same class of files.
5. **Fragmented verification**: 17 verification tool calls (vitest 5, verify and gates 5, tsc 2, lint 3, git 5), including three runs of one package's suite and two runs each of translation-pairing and doc-quick.

## 4. The plan

Execute in A-then-B-then-C order. Tier A is risk free; tier B's B1 and B2 depend on the cache-invalidation root cause from section 1.3 and stay frozen until it is found; every tier C item lands in a specification document.

### 4.1 Tier A: working methods and orchestration

| Item | Action | Gain | Risk |
|---|---|---|---|
| A1 | Tier local verification: run only affected packages plus their runtime dependents; leave full and coverage runs to CI. The rule lives in the "Local verification scope" section of `../testing.md` | Verification drops from 143s to 3–6s for a single-package change | Cross-package impact missed; mitigated by "package plus runtime dependents". Editing a base package still widens the scope |
| A2 | `scripts/verify-changed.ts`: `git diff` computes the affected packages and one run covers their vitest. `--list` prints the scope only; `--direct-only` drops dependents and keeps changed packages | 17 verification calls collapse to 1–2, saving about 15 steps, roughly 1.5 to 2.5 min | New script, orchestrating existing commands only |
| A3 | Finish docs and Notes in one pass: code and unit tests first, then bilingual docs, i18n, the Agent Note, and their gates together in a closing phase. The rule lives in [`dsh-agent-task-execution`](../../.agents/skills/dsh-agent-task-execution/SKILL.md) | Removes re-location caused by interleaving; that phase measured 38% | None |
| A4 | Persist diagnosis structurally: before a turn ends, write "file:line plus conclusion" into a todo or plan so the next turn consumes it directly. Same skill | Saves 3 to 4 min of repeated location | None |

### 4.2 Tier B: runtime configuration

| Item | Action | Prerequisite | Risk |
|---|---|---|---|
| B0 | Locate the two KV cache invalidations from section 1.3 | None | Done; see the conclusion below |
| B1 | Move `compaction-basic.thresholdRatio` from 0.8 to 0.5–0.6 | B0 | **Rejected.** Compaction rewrites history through replace, so every compaction starts a new request series and voids the entire prefix cache, on top of costing one LLM summary |
| B2 | Move `tool-result-pruner.thresholdChars` from 8192 to 4096–6144 | B0 | **Rejected.** Each pruned tool result is one replace, so lowering the threshold raises the number of full invalidations proportionally |
| B3 | Move `repeat-tool-reminder.thresholds` from `[3, 5, 8]` to `[2, 4, 6]` | None | Reminder noise |
| B4 | Strengthen parallel tool-call guidance: issue several independent reads, searches, and globs in one assistant message, while calls that depend on an earlier result keep their own step. The rule lives in [`dsh-agent-task-execution`](../../.agents/skills/dsh-agent-task-execution/SKILL.md) | Saves about 11 steps of fixed overhead, roughly 1 min | None |

### 4.2.1 B0 conclusion: the provider breaks the cache, and B1 and B2 would break it deliberately

Rule out a prefix change on this repository's side first, then locate the real cause.

**This repository's prefix is stable**, on four pieces of evidence:

1. `system` is static throughout — the `request/header` record holds a 6,890-character system prompt with no timestamps and no dynamic segment beyond the checkout path.
2. `tools` never changes — `request/header` is appended exactly once in the whole session (`reason: initial`), and `agent.ts` records `reason: change` only when `headerEquals` is false, so the tool catalog never moved.
3. Messages are append-only — the session contains zero `compaction/prune` events, so neither compaction nor pruning fired, and `request-reconstruction.spec.ts` pins `deriveMessages()` rebuilding deterministically in its THEOREM case.
4. The event sequence around both invalidations is clean — no retry, no injection, no replace; total context grows by only 1,896 and 295 tokens across the two adjacent steps, the same order as neighbouring normal steps.

**The break comes from the provider**: after each invalidation only 1,152 and 256 tokens hit, both integer multiples of the 64-token cache block and both far shorter than the system prompt itself, so only the prefix shared across sessions hit while this session's own history missed entirely. `~/.dsh` holds just one other session in that period, ended at 17:22 and not overlapping the 18:55 and 19:04 invalidations, which rules out contention between sessions; adjacent requests are under three seconds apart, which rules out a TTL. The likely cause is load balancing onto a different inference node, or eviction from a shared token plan's cache pool. That is external service behavior this repository cannot fix.

**This exposes what B1 and B2 really are**, though. In `packages/core/session/src/surface.ts`, every `surfaceOp: { op: 'replace' }` swaps the old event out of the ordered surface, so `deriveMessages()` emits the rewritten message and the next request diverges from its predecessor's prefix at that point, missing the provider's prefix cache for everything after it. The `replaceGeneration` counter, and the `startsSeries` boundary `agent.ts` records from it, marks the rewrite in the log; neither is the cause of the miss — the rewritten content is. `tool-result-pruner`'s `pruneSession` and compaction's replacement both travel that road.

The bottom line: the two observed invalidations are occasional provider behavior costing about 97k tokens of recomputation, roughly 4% to 7% of the 14.6 minutes at prefill throughput, so they are not the dominant cost; whereas shipping B1 and B2 would turn that occasional behavior into a guaranteed invalidation on every history rewrite. **The current 0.8 and 8192 defaults protect the prefix** — neither compaction nor pruning fired in this session, which is exactly why the hit rate stayed at 99%.

Should context ever need shrinking, the correct shape is append-only — append a summary and move the old nodes out of the surface rather than replacing history events. Per the measurement above, that change carries no benefit today.

### 4.3 Tier C: engineering-completeness trade-offs

| Item | Current state | Change | Gain |
|---|---|---|---|
| C1 | Every non-trivial change writes a full Agent Note (md, zh, i18n, Alternatives, Consequences) plus two verify classes | Tiered Agent Notes; criteria below | Phase D drops from 19 steps to 8–10, saving about 2 min |
| C2 | The zh side and `*.i18n.yaml` are hand-maintained by the agent, then `verify-translation-pairing --write` runs | After the English is final, generate zh and i18n in bulk at PR time | Another 30% to 40% off C and D |
| C3 | `doc-quick` takes 14.5s and ran twice in this session | Split into a sub-second quick tier (run per change) and full doc-sync (run before PR) | Saves one 14.5s run plus one round trip |
| C4 | per-file 100% coverage is the CI gate | Locally run coverage only for affected packages; full coverage belongs to CI | No extra local cost; already the de facto state |

**C1 tiering criteria**, evaluated in order; any hit means a full Note:

1. The change crosses a `packages/<group>/` boundary.
2. It adds or modifies a `SessionEventMap` member.
3. It adds or modifies a capability seam (any of Service Definition, Service Provider, Consumer).
4. It touches `packages/core/agent-loop`.
5. It changes a model-visible input, which requires a new session event.

When none apply — single package, no new seam, no protocol or model-visible change — write a **compact Note** with three sections only: current state, decision, verification.

## 5. Impact

| Object | Impact |
|---|---|
| `../testing.md`, root `../AGENTS.md` | A1 adds the local verification tiering rule and command templates |
| `scripts/verify-changed.ts` | Added by A2 |
| `../../packages/preset/agent-presets/presets/standard/agent.cordis.yml` | Change site for B2 and B3 |
| `../../packages/compaction/compaction-basic/src/config.ts` | Change site for the B1 default |
| `.agents/notes/AGENTS.md` | C1 tiering criteria join the Agent Note rules |
| `../i18n/README.md` | C2 records when bilingual output is produced, in the pairing contract |
| CI gates | Unaffected. Full runs, `test:coverage`, and `doc-sync` stay with CI; A through C change local working methods only |

## 6. Follow-up tasks

Execute in dependency order, verifying each item:

1. A1 closes out: the root `../AGENTS.md` is 2737 words against a 1950 ceiling, so it must be condensed per the relocate-then-condense order in `docs/AGENTS.md` before the local verification link can join it.
2. B3 and B4 land with one regression check each.
3. Record that replace voids the prefix cache in `packages/core/session/README.md` and in the READMEs of `compaction-basic` and `compaction-tool-result-pruner`, so a later reader does not mistake pruning or compaction for a harmless optimization.
4. C1 tiering criteria land in `.agents/notes/AGENTS.md`.
5. C2 bilingual timing lands in `../i18n/README.md`, and the items below get cleared.
6. C3 splits `doc-quick` into tiers, with script-side support.
7. C4 records the local coverage convention in `../testing.md`.
8. Clear the typert generator red: `schema-emitter.spec.ts` fails 75 tests and `type-model.spec.ts` fails 33 (stale `lib/` artifacts in this worktree are the likely cause), which is what leaves `.rendered-model-*` directories behind.
9. Investigate the `snapshots/session/repeat-tool-reminder` snapshot timing out at 45s on this machine: B3 ran the scenario once before and once after changing the threshold to `[2, 4, 6]`, and it timed out both times, so this is baseline rather than caused by the configuration; confirm the real behavior on a machine where the scenario completes.

Bilingual debt: `docs/gui-polish-standard-mode-rationale.md` has no Chinese counterpart or i18n sidecar, and `docs/event-producer-consumer.md` changed on the English side without re-recording its pair. Both were already red before this document landed.

## 7. Rejected options

| Candidate | Why not |
|---|---|
| Lower reasoning effort for speed | The 12:1 thinking-to-prose ratio is the single largest cost, but lowering it lowers quality directly and needs a chosen replacement model. Recorded here as a follow-up optimization, to reopen once model selection is settled |
| Route the exploration phase to a faster model | Same as above; depends on replacement model selection |
| Lower the per-file 100% coverage threshold | That threshold is the core quality gate and CI owns it; local cost is already avoided by C4 and A1, so the threshold need not move |
| B1 and B2, lowering the compaction and pruning thresholds | Both rewrite history through replace, which starts a new request series and voids the entire prefix cache, turning a 2.7% occasional miss into a guaranteed one on every rewrite; see section 4.2.1 |
| Edit Lint configuration to exclude generated directories | Forbidden by policy; the correct handling for generated directories is cleaning the residue, as section 5.1 of the Chinese side notes |

## Appendix: one LintBot false positive

`packages/typert/generator/tests/type-model.spec.ts` creates the temporary directory `.rendered-model-*` with `mkdtempSync` to render a type model. After that suite failed (33 tests), the directory stayed in the worktree; untracked by git, it was swept into the LintBot scan and produced 186 findings, concentrated in `client.d.ts`, `external.d.ts`, and `host.d.ts`.

Those files are not source: tests generate them and the next run overwrites any edit. The resolution was to delete the residue, leaving both the Lint configuration and the renderer untouched. The underlying cause is that the typert generator suites are still red (`schema-emitter.spec.ts` 75 failures, `type-model.spec.ts` 33 failures) and need their own investigation, most likely stale `lib/` artifacts in this worktree.
