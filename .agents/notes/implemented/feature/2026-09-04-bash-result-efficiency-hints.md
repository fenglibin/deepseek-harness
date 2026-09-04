# Agent Note: Bash results carry runtime hints toward unused capabilities

Status: implemented

English | [中文](2026-09-04-bash-result-efficiency-hints.zh.md)

## Problem

A profiled session (`session-68379efa`, 2 turns, 389 steps, 112.9 min wall clock) spent its time on model behavior rather than slow execution: searching through `bash` (`grep` in 85 commands, `find` in 15, while the `fs_search` tool ran 0 times), waiting with five fixed `sleep` calls of 90–300 s instead of `job_output`'s `wait: true`, and probing for about 20 minutes before calling `ask_user_question`. Every capability the model needed already existed.

[tool-jobs](../../../../packages/jobs/tool-jobs/src/index.ts) already carries system-prompt guidance against busy-polling a job, and that session ignored it: the model slept five times while the completion notices it was told to rely on were in fact being delivered. Guidance stated once at the head of a session does not compete with the reflex at the moment of the call, so whatever fixes this has to arrive in the result of the call that exhibits the pattern. The measurements and the rejected readings of them are [the design document](../../../../docs/design/agent-tool-efficiency.md).

## Decision

`renderResult` in [render.ts](../../../../packages/shell/tool-bash/src/render.ts) appends the lines the exported pure `efficiencyHints(command)` returns, before the timeout/signal/exit markers. Three triggers, each deliberately narrow:

| Trigger | Fires when the command | Steers toward |
|---|---|---|
| Fixed wait | contains `sleep <n>` with `n >= 30` seconds | `job_output` with `wait: true` and `timeout_ms`, which returns the moment the job settles |
| Shell search | starts with `grep` or `find` after prefix stripping | `fs_search`, which needs no shell quoting |
| Repository-wide verification | contains `--coverage` or matches `pnpm [run] test…` / `npx vitest run` — in either case only when no token looks like a path or file argument | scoping the run to the affected packages |

The scope exclusion governs `--coverage` too, not just the test-run patterns: §3.4 of the design states the trigger "fires only on unscoped verification", so `npx vitest run packages/api --coverage` must not fire even though it contains `--coverage`. The literal "contains `--coverage`" clause is read through that rule.

A leading `cd <path> &&` is stripped before matching because that is how the model wrapped 234 of the 242 measured calls. A piped `grep` does not qualify: it filters another command's output, which no search tool substitutes for. Both named tools ship in every preset that mounts the bash tool, so no hint points at an absent tool.

Two invariants the composition depends on:

- **Hints precede the exit marker.** `parseExitStatus` anchors on the final line and the terminal card's exit pill is parsed from it, so a hint appended after the marker would silently break the pill on every hinted result.
- **`efficiencyHints` is a pure function of the command.** No registry lookup and no dependence on plugin load order, so a replay and a live call render identical text.

The text states the cost instead of forbidding the command, so a deliberate whole-repository run proceeds unchanged.

## Alternatives considered

**System-prompt guidance alone.** Rejected: that is the status quo for job polling and the profiled session ignored it.

**Carrying hints in the tool's output schema.** Rejected: a schema field is a wire and snapshot contract, while these hints are presentation text. Rendering them leaves canonical values, persisted snapshots, and the wire untouched.

**A command-dedup hint.** Rejected: only 5 of 242 calls repeated, and `repeat-tool-reminder` already fires on repeats.

**Gating hints on runtime tool availability.** Rejected: a registry lookup in `render` would make its output depend on plugin load order, and every composition that mounts the bash tool already mounts both tools the hints name.

**Parsing `sleep` suffixes such as `sleep 1m`.** Deferred: every measured wait was a bare seconds count, macOS `sleep` rejects suffixes, and supporting them costs a second fallback path for a rare form. A suffixed wait is a missed hint, never a wrong one.

**Hinting on `cat`, `sed`, or `ls`.** Rejected: `sed` counts came mostly from edits that `edit` cannot express, so the hint would be wrong about as often as right.

## Consequences

About 70 of the 242 measured commands gain one line; the rest render byte-identically to before. A hint is retained transcript text, so it costs input tokens until compaction and sits after the reusable request prefix, leaving KV-cache reuse intact.

Hint 3 quotes a measured cost (~143 s for 17,429 tests) taken from [the latency profile](../../../../docs/design/agent-task-latency.md); that number drifts as the suite grows, and it is evidence of scale rather than a live measurement.

`dsh-tool-pwsh` carries no hints. Its renderer is a deliberate twin of the bash one, but every trigger names a Unix command (`grep`, `find`, `sleep`) or this repository's `pnpm`/`vitest` idiom, none of which exist on the PowerShell path.

Verification: [render-hints.spec.ts](../../../../packages/shell/tool-bash/tests/render-hints.spec.ts) pins the matcher, the near misses, the `cd` stripping, and the marker-order guarantee that keeps the exit marker last; [tools.spec.ts](../../../../packages/shell/tool-bash/tests/tools.spec.ts) executes a triggering command through the real tool and asserts the hint reaches the model-facing text, and asserts the background acknowledgement does not carry one. Whether the hints change model behavior on a real task stays an owner judgment no unit test can make.
