# Delivery Discipline Auto-Trigger Design

English | [中文](delivery-discipline-auto-trigger-rationale.zh.md)

> Status: proposal, awaiting user confirmation (no code written yet)
> Audience: maintainers
> Related: the [delivery-discipline design](delivery-discipline-rationale.md), whose batches B1–B5 shipped the task domain, the phase state machine, artifact persistence, post-hooks, and the client UI. This document closes the one gap those batches left open: nothing starts the discipline automatically.

---

## 1. Background and motivation

The [delivery-discipline design](delivery-discipline-rationale.md) states its own core principle in section 1: *flow constraints must not depend on LLM self-discipline; they must be enforced by programs*. Batches B1–B5 delivered the programmatic half — the `DeliveryTask` domain, the forward-only state machine, the `record_*` tools, the `advance` gate, and post-hooks — but every one of those activates only after the model voluntarily calls `create_delivery_task`. Nothing programmatic detects a large request and starts a task, so the model can (and does) skip the entire discipline by never creating one.

A real session demonstrates the failure. A large request ("process image-and-text mixed input") ran through the `brainstorming` skill, asked the user two rounds of `ask_user_question`, and wrote a design document directly under `docs/design/` with the `write` tool. Across the whole session the delivery tools were called exactly once — `get_delivery_task`, which returned `{ task: null }`. `create_delivery_task`, `record_design`, `record_spec`, `record_change`, and `advance_delivery_task` were each called zero times. The design document landed outside `.dsh/design/`, and the agent ended by asking "do you want me to open a delivery task now", treating the discipline as an optional next step rather than a default.

The same prompt-only pattern governs the neighboring `goal` capability: `create_goal`'s description says the model "may infer that intent", but nothing enforces it. This design does not rework `goal`; it gives the delivery discipline the programmatic start its own principle demands.

---

## 2. Goals

- **Auto-detect** a large request and create a delivery task without the model having to remember to do it.
- **Auto-verify** completeness against the artifacts that actually exist: when a task carries a design record or a spec record, reaching `accepted` requires a programmatic check that the implementation covers them; a task with no such records is not blocked, so the discipline never stalls ordinary work.
- **Default the rear gate on**: ship a non-empty `postHooks` baseline so "acceptance follows verification" holds out of the box.
- **Auto-record** a change at acceptance so every completed task leaves a change record even if the model forgets `record_change`.

---

## 3. Non-goals

- Do not change `agent-loop` itself (following "Plugins, not loop changes"); the start hook reuses an existing event.
- Do not re-spec the phase state machine or the `record_*` tools; they are correct as shipped.
- Do not constrain subagents or workflow subtasks; the root agent's task remains the only scope.
- Do not judge whether the implementation is *semantically correct*; the completeness check verifies *coverage of the recorded artifacts*, not business correctness (that stays with post-hooks and tests).

---

## 4. Current state

Shipped and working: the `DeliveryTask` domain, the forward-only phase order, the `delivery` projection, the six model-facing tools, artifact persistence to `.dsh/` and `openspec/`, post-hooks, and the client timeline card plus floating card.

Four gaps remain, all on the "start" and "finish" edges:

| Gap | Evidence | Consequence |
|---|---|---|
| No auto-detect | `create_delivery_task` is only ever called by the model; `inferLevel` runs only inside it | A large request runs with no task, no tier, no gate |
| No completeness verification | `gateAdvance` checks only `designed`/`specified`/`implemented` record counts; `verified` has no prerequisite | A task can reach `accepted` with design/spec records present but unimplemented |
| `postHooks` empty by default | `Config.postHooks` defaults to `[]`; presets set only `enforcement: stateful` | Acceptance runs no verification command out of the box |
| No auto change-record | `record_change` is a model-facing tool only | A completed task can reach `accepted` with `changeCount === 0` if the model forgets it |

---

## 5. Options considered

### Option A: auto-create at `agent/pre-step` (recommended)

A waterfall listener on `agent/pre-step` reads the session's current delivery task; when none exists and the claimed human message meets the size proxy, it creates an `l1`/`l2` task before the step proceeds. This is the same event `compaction-basic` and `plan-mode` already use to inject durable material, so the pattern is established and the created task is reconstructable from the session log.

- **Bought**: the discipline starts without the model's cooperation; the real message text (not an estimate) drives the tier.
- **Cost**: `pre-step` runs every step, so the listener must be idempotent and cheap; creating a task is a durable append, which is already how `plan-mode` writes.

### Option B: auto-create at message admission (session controller)

Create the task in `session-controller.prompt()` when a human message arrives and no task exists.

- **Bought**: the creation sits exactly at the "user submitted a request" boundary.
- **Cost**: the session controller is the API plane; delivery is a host-plane domain, and a request may span several messages before its size is knowable. It also couples the API layer to a host service.

### Option C: strengthen the system prompt only (control)

Reword `guidance()` to order the model to create a task immediately for large work, with no code change.

- **Bought**: zero code, zero risk.
- **Cost**: the session evidence already disproves this; the model ignored the existing instruction. It contradicts the design's own core principle.

### Option D: soft reminder at `agent/turn-stopping`

Do not create a task; at turn end, detect substantial work with no task and inject a reminder context.

- **Bought**: never disturbs exploration.
- **Cost**: a reminder is not a start; the model can ignore it exactly as it ignores the prompt today.

**Decision**: Option A for the start, plus two finish-side additions — a completeness gate at `accepted` and a non-empty `postHooks` baseline. Option C and D are rejected because they reintroduce the LLM-self-discipline the principle forbids.

---

## 6. Recommended design

### 6.1 Auto-detect and auto-create

A new plugin (or an extension of `tool-delivery`) registers a waterfall listener on `agent/pre-step`. On each step it resolves the calling agent's session and the current `ctx.delivery` view:

- A current task exists, or the claimed messages carry no direct human request → do nothing (fall through `next()`).
- No current task and a direct human request is present → measure the concatenated request text against `designThreshold`/`openspecThreshold` and call `ctx.delivery.create()` with the inferred level and the request text as the objective, then fall through.

The created task is visible immediately in the existing timeline card and floating card; no new UI is required. The tier follows the same proxy as `create_delivery_task` today, so an explicitly under- or over-sized request can still be corrected by the model through the existing tools.

### 6.2 Completeness verification at `accepted`

`gateAdvance` gains one prerequisite: advancing to `accepted` requires that every design and spec record is covered by an implementation. "Covered" is programmatic where the record format allows it, and delegated otherwise:

- **Spec records (l2)** write `openspec/changes/<task-id>/spec.md`; when the full openspec `tasks.md` layout exists, coverage means every checkbox is ticked, verified by reading the file. This is fully programmatic.
- **Design records (l1/l2)** are free text with no machine-checkable checklist. Coverage here is verified by the model: `advance` to `accepted` returns a blocking error listing the unverified design records and instructs the model to confirm each was implemented, mirroring the existing `DELIVERY_GATE_BLOCKED` flow. The confirmation is a recorded statement, not silent assent.

A task with zero design and zero spec records skips this check entirely — the "verify only what exists" rule the user specified — so an `l0` fix never stalls.

### 6.3 Default rear gate

Presets and the bundle set `postHooks` to a non-empty baseline (for example `openspec validate --strict` and `pnpm run test`), so acceptance runs verification by default. The field stays overridable per deployment.

### 6.4 Auto change-record at acceptance

When `advance` reaches `accepted`, if `changeCount === 0` the tool records one change summarizing the objective before committing the advance, so no task completes without a change record.

---

## 7. Implementation batches

| Batch | Content | Acceptance signal |
|---|---|---|
| C1 | `agent/pre-step` auto-detect listener + size-proxy reuse + idempotence | A large request creates a task with no model call; a small fix does not |
| C2 | Completeness gate at `accepted` (spec checkbox check + design confirmation) | A task with records cannot reach `accepted` until they are covered; a record-free task is unaffected |
| C3 | `postHooks` baseline in presets + auto change-record at acceptance | Acceptance runs the configured commands and every completed task has a change record |

Each batch is independently verifiable and rollback-able, matching the original design's staging discipline.

---

## 8. Risks and rollback

| Risk | Impact | Mitigation |
|---|---|---|
| Auto-create fires on a trivial request | A small fix is forced into a task | Reuse the size proxy; a below-threshold request stays task-less |
| `pre-step` listener cost | Extra work every step | Resolve the task once, short-circuit when a task exists |
| Completeness check blocks legitimate work | A task cannot finish | The check only runs when records exist; the model confirmation path is the escape hatch |
| The confirmation path is still model-gated | The model can falsely confirm | The confirmation is recorded as a durable statement, and post-hooks run regardless |

**Rollback**: C1–C3 are independent config/tool additions. Disabling the auto-detect listener or setting `postHooks: []` restores today's behavior; the state machine and tools are unchanged.

---

## 9. Open questions

These need a decision before implementation; they are deliberately listed rather than decided here.

1. **Auto-detect mount point.** `agent/pre-step` (Option A) versus message admission (Option B). This document recommends A.
2. **Tier thresholds.** Reuse the existing `designThreshold`/`openspecThreshold` character/todo/file proxies, or a separate threshold for the auto-start path?
3. **User visibility of the auto-created task.** Silent creation (matches "do not make the user perceive it") versus a short notice when a task is created automatically.
4. **Completeness check depth.** For design records, is the model-confirmation path acceptable, or must every design decision become a machine-checkable item?
