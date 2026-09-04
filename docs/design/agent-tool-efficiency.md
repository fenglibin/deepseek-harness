# Agent tool-use efficiency: runtime hints for bash

English | [中文](agent-tool-efficiency.zh.md)

This document specifies three narrow runtime hints appended to `bash` results, which steer the model toward the specialist tools and event-driven waits the harness already provides. Measurements come from `~/Downloads/session.jsonl` (session `session-68379efa`, 2 turns, 389 steps, 112.9 min wall clock). A previous profile of a different session lives in [agent-task-latency.md](agent-task-latency.md).

## 1. The problem

One task — summarize session titles with an LLM, plus a lightweight-model routing card — consumed 389 steps. `turn 2` alone took 95.7 min over 354 steps. The time went to three model behaviors, not to slow execution.

| Behavior | Evidence | Harness capability that went unused |
|---|---|---|
| Searching and browsing through `bash` instead of the specialist tools | `grep` appears in 85 commands, `sed` in 44, `ls` in 32, `cat` in 15, `find` in 15; the `fs_search` tool was called **0 times** | `tool-fs-search` |
| Polling with fixed `sleep` instead of an event-driven wait | 5 `sleep` calls (90/240/300/300/240 s) = 19.5 min; the five slowest steps are all `sleep`; plus `list_agents` 14 and `job_output` 20 poll calls | `job_output` with `wait: true` ([tool-jobs](../../packages/jobs/tool-jobs/src/index.ts)), and completion notices |
| Probing instead of asking | `python3` 25 commands, `ask_user_question` called once after ~20 min of probing | `ask_user_question` |

The three share one property: **the capability already exists and was not used.** That is why the fix is a runtime hint, not new machinery.

### 1.1 What is *not* the problem

Two measurements that look alarming are artifacts and must not drive work:

- **Command repetition is negligible.** Of 242 `bash` calls, **237 are distinct**; only 5 repeat. A command-dedup hint would fire almost never.
- **`tool/call` → `tool/result` elapsed time is not tool execution time.** It includes the model generating the next step. It reports `read` at 190 s and `bash` at 49 s per call, both impossible for the real work. Only step-level timing and inherently-timed commands (`sleep`) are trustworthy.

### 1.2 The `sleep` cost is the polling, not the waiting

The five `sleep` calls fall between 86.3 min and 105 min, waiting on subagent `68712351`, which ran from roughly 80 min to 108.9 min. The wait itself was mostly necessary. What is wasteful is the *form*:

- A fixed `sleep` always burns its full duration, even when the job settles in seconds; `job_output` with `wait: true` returns the moment the job settles.
- Each `sleep` plus its follow-up check costs a step, and every step pays a fixed scheduling round trip.

So the recoverable cost is the 34 poll calls and the over-wait, not the full 19.5 minutes.

## 2. Why prompt guidance alone is insufficient

[tool-jobs](../../packages/jobs/tool-jobs/src/index.ts) already registers this system-prompt section:

```text
You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work.
```

The session shows that guidance was present and ignored: the model slept five times, and the completion notices it was told to rely on were in fact delivered (several `background job … finished` and `Background subagent … finished` messages appear in the log). A general rule stated once, far from the moment of action, does not change behavior here. The hints below fire **in the result of the very call that exhibits the pattern**, which is the difference this design relies on.

## 3. The plan

Add one exported pure function and call it from the `bash` result renderer. Three hints, each with a deliberately narrow trigger. Nothing here changes the tool's output schema; the hints are text appended by the renderer, so canonical values, snapshots, and the wire contract are untouched.

### 3.1 Where the hints attach

[`render.ts`](../../packages/shell/tool-bash/src/render.ts) owns the model-facing text in `renderResult`. Its markers array ends with the exit marker, and `parseExitStatus` anchors there, so **a hint must be inserted before the exit marker, never appended after it**.

Concretely:

1. Add `export function efficiencyHints(command: string): readonly string[]` to [`render.ts`](../../packages/shell/tool-bash/src/render.ts). It is pure: same command in, same hints out.
2. Extend `renderResult(result, escalationModes, command = '')` with the command, call `efficiencyHints`, and push the returned markers into `markers` **before** the `timedOut` / signal / exit-code block.
3. Pass the command at the call site in [`index.ts`](../../packages/shell/tool-bash/src/index.ts), where `render` already receives `args`.

Commands arrive as `cd <path> && <real command>` in 234 of 242 calls, so the matcher strips one leading `cd <path> &&` before testing.

### 3.2 Hint 1 — `sleep` instead of an event-driven wait

- **Trigger**: the stripped command contains `sleep <n>` with `n >= 30`.
- **Text**: `[hint: to wait on a background job, call job_output with wait: true and timeout_ms; it returns the moment the job settles, instead of sleeping a fixed duration]`
- **Narrowness**: 5 hits in the profiled session. This is the highest-value hint per firing.

### 3.3 Hint 2 — searching or browsing through `bash`

- **Trigger**: the stripped command starts with `grep` or `find` (53 and 9 hits as the leading word). Piped `grep` (`| grep`) does **not** qualify — it filters another command's output, where a specialist tool cannot substitute.
- **Text**: `[hint: code search through the fs_search tool is structured and avoids shell quoting; prefer it over grep/find for locating code]`
- **Narrowness**: ~62 hits, the largest class, which is why it is worth a hint despite a broader trigger.

### 3.4 Hint 3 — whole-repository verification

- **Trigger**: the stripped command contains `--coverage`, or matches `pnpm (run )?test` / `npx vitest run` **with no path argument** (a bare run sweeps the whole repository).
- **Text**: `[hint: this runs the whole repository suite (measured ~143 s for 17,429 tests); scope it to the affected packages — see docs/testing.md]`
- **Narrowness**: fires only on unscoped verification. A scoped run such as `npx vitest run packages/api` must not fire.

### 3.5 Explicitly out of scope

- **No command-dedup hint.** Repetition is 5 of 242 calls, and `repeat-tool-reminder` already fires (twice in this session).
- **No hint for `cat`, `sed`, `ls`.** `sed` edits, which `edit` cannot express mechanically, dominate its count; a hint would be wrong as often as right.
- **No change to `job_output`**, `tool-jobs`, or any guidance text. The capability is correct; only its discovery at the moment of use is missing.

## 4. Risks

| Risk | Assessment |
|---|---|
| Hint noise in the transcript | Bounded by the narrow triggers: roughly 70 of 242 calls, one line each. The owner chose narrow triggers over broad ones for this reason. |
| A hint fires on a legitimate command | Hint 3 could fire on a deliberate full run. The text states the cost rather than forbidding the command, so a deliberate run proceeds. |
| Breaking `parseExitStatus` | Real if a hint were appended after the exit marker. Section 3.1 makes insertion order a stated requirement; cover it with a test asserting `parseExitStatus` still finds the exit marker when a hint is present. |
| Snapshot churn | Hints change the model-visible text of `bash` results. Any snapshot whose input includes a triggering command needs re-recording. |
| Over-firing on `grep` | Mitigated by excluding piped `grep`. If measurements later show noise, narrow further to recursive forms (`grep -r`) only. |

## 5. Verification

The owner verifies by hand on a real task; this document does not prescribe an automated benchmark. For each hint, confirm:

1. A command matching the trigger produces a result whose text contains the hint, with the exit marker still last.
2. A near-miss does **not** fire: `sleep 5`, `some-command | grep x`, and `npx vitest run packages/api` each produce unmodified text.
3. `parseExitStatus` parses the exit code out of a result that carries a hint.

Unit tests cover the pure matcher and the ordering guarantee:

- `efficiencyHits` returns each hint for a matching command and `[]` for the near-misses above.
- `renderResult` with a hint keeps `[exit code: N]` as the final marker.
- The `cd <path> &&` prefix is stripped before matching.

## 6. Decision log

| # | Decision | Conclusion |
|---|---|---|
| 1 | Runtime hints versus system-prompt guidance | Runtime hints. Prompt guidance on the same topic is already present and was ignored (section 2). |
| 2 | Schema change to carry hints | Rejected. The hints render as text, so canonical values and the wire contract stay fixed. |
| 3 | Command-dedup hint | Rejected: 5 of 242 calls repeat, and `repeat-tool-reminder` already covers it. |
| 4 | Deduping by `tool/call` → `tool/result` timing | Rejected: that interval includes model generation, so it is not tool cost (section 1.1). |
| 5 | Trigger breadth | Narrow, per owner decision: a hint fires only on the specific pattern it names. |
