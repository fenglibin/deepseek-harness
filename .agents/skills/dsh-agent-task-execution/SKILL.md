---
name: dsh-agent-task-execution
description: Use when working a multi-step coding task in this repository, to spend model round trips on the change instead of on ceremony — finish code and unit tests before touching documentation, close out bilingual docs and the Agent Note in one pass, persist diagnosis as structured findings before a turn ends, and verify only the affected package scope.
---

# DSH Agent Task Execution

A measured task in this repository — 189 lines across 12 files, one package — took 75 model round trips and 14.6 minutes of agent time. Fitting `step duration = 4.91s + 15.1ms × output tokens` over those 75 steps shows where it went:

| Phase | Share of agent time | Steps |
|---|---|---|
| Diagnosing the fault | 27% | 26 |
| Re-locating code the previous turn already found | 26% | 11 |
| Writing the change and its tests | 9% | 9 |
| README bilingual copy, i18n sidecar, pairing gate | 12% | 10 |
| Agent Note bilingual copy, format gate, final verification | 27% | 19 |

Two facts drive this skill. Ceremony — bilingual documentation, i18n sidecars, Agent Notes, and their gates — cost 38%, more than writing the code. Re-locating files an earlier turn had already found cost another 26%. Both are round-trip costs, not thinking costs, and both are avoidable by ordering the work differently.

## Work in three phases

Interleaving is what makes the bill grow. Finish one phase before starting the next:

1. **Locate and change.** Read, search, and edit until the behavior is right and the owning unit tests pass. Do not touch documentation, Agent Notes, or sidecars in this phase, even when the file you are editing sits next to one.
2. **Verify.** Run only the affected scope, as described below.
3. **Close out.** Write every documentation and Agent Note artifact in one pass, then run their gates once.

A task that grows a new public type, event, or capability seam still updates its owning subsystem page and Agent Note; the rule is about *when*, never about whether.

## Issue independent calls together

When one step needs several independent reads, searches, or glob patterns, put every one of them in the same assistant message instead of one per step. Each extra round trip costs about 4.9 seconds of fixed overhead — replaying the full context and paying one scheduling hop — regardless of how little the model writes. In the measured session, 19 of 75 steps issued a single serial tool call and 16 steps emitted fewer than 100 tokens; that is the shape of "confirm the result, then call the next tool", and merging those cases is worth about a minute on its own.

Keep dependent calls in separate steps. A search whose pattern depends on what a read returned, or an edit that must follow a fresh read of the file, still gets its own step — a parallel batch cannot see the result it depends on.

## Close out documentation in one pass

In the closing phase, write all of these together rather than as each file reminds you:

- the package or subsystem README in English, then its Chinese counterpart, then `verify-translation-pairing --write` once
- the Agent Note, compact or full per the criteria below
- any generated catalog the change invalidates

Each separate pass costs a fresh round trip over the full context, and a pass that happens between edits re-reads the same files to recover the state you already had. One closing pass turns four or five round trips into one.

### Agent Note tiering

Write a **full** Note when any of these holds; otherwise write a **compact** Note with three sections only — current state, decision, verification:

1. The change crosses a `packages/<group>/` boundary.
2. It adds or modifies a `SessionEventMap` member.
3. It adds or modifies a capability seam: any of Service Definition, Service Provider, or Consumer.
4. It touches `packages/core/agent-loop`.
5. It changes a model-visible input, which requires a new session event.

## Persist diagnosis before a turn ends

Before ending a turn that reached a conclusion, record the finding as `file:line` plus one line of conclusion, in the todo list or plan the next turn will read. A turn that ends with only prose forces its successor to re-read the same files; in the measured session that cost 3.8 minutes and 11 steps.

Write conclusions that a later turn can act on directly:

```text
packages/api/session-controller/src/commands.ts:281 — ctx.sessionPersistence throws
"without inject" because sessionPersistence is a sibling row, not an ancestor;
ctx.get('sessionPersistence') reaches it. See docs/postmortem/0001-acp-default-export-drops-inject.md
```

Prefer the todo tool or plan mode over a scratch file, so the next turn loads the finding without a search.

## Verify the affected scope only

Run the packages a change touches plus their runtime dependents. The full suite takes 143 seconds for 17,429 tests and `test:coverage` takes minutes; both belong to CI.

```sh
npx tsx scripts/verify-changed.ts                # run the affected packages and their runtime dependents
npx tsx scripts/verify-changed.ts --list         # print the scope without running it
npx tsx scripts/verify-changed.ts --direct-only  # changed packages only, when the blast radius is known
```

The script derives its scope from `git diff` and each manifest's `dependencies`. It deliberately ignores `devDependencies`: a large share of this workspace lists `dsh-*` packages there, and treating a test-time relationship as a runtime edge spread a 24-package change across 163 packages.

See [Local verification scope](../../../docs/testing.zh.md#本地验证范围) for the tiering rule.

## Do not trade these away

Three optimizations look tempting and are losses:

- **Lowering the compaction or tool-result-pruning thresholds.** Both rewrite history through `surfaceOp: replace`, which rewrites the messages the next request sends, diverging its prefix and voiding the entire provider prefix cache. The current `0.8` and `8192` defaults kept the measured session's hit rate at 99%.
- **Batching everything into fewer, larger steps.** Output tokens cost time too; the fit above charges 15.1 ms each. Merge steps that are pure ceremony or re-location, not steps that produce the change.
- **Skipping the closing phase when the change is small.** A change that alters a documented type or a model-visible input still owns its subsystem page and Agent Note; deferring the *phase* is the optimization, never dropping the artifact.
