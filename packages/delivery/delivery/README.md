---
description: "The persisted same-session delivery-discipline task service for users and maintainers choosing, configuring, or debugging one durable change-tracked task per session."
kind: "package-reference"
---

# @deepseek-ai/dsh-delivery

English | [中文](README.zh.md)

## Summary

`dsh-delivery` keeps one durable delivery task per agent session: the task's objective, size class (`l0` small fix, `l1` adds a design, `l2` adds an openspec split), lifecycle phase, and recorded change count live in the session log, so they survive session resume, fork, and process restarts. You can create, advance, record a change against, and clear a task, and every mutation is compare-and-set, so a stale view cannot clobber newer state. The task moves forward through its level's phase order only — `created → designed → specified → implemented → verified → accepted` — and skipping a required phase is rejected. It is state, not policy: the service enforces the phase order, while the model-facing gate strength (`stateful` / `advisory` / `off`) belongs to `dsh-tool-delivery`. Choose it when one piece of work should produce a change record and advance through a disciplined lifecycle; skip it for routine single-turn work.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-delivery` whenever a session should remember one change-tracked task across turns and restarts. The package is a service: the model tools live in `dsh-tool-delivery`, which consumes the same task state, so mounting only this package stores and serves the task without exposing any tool.

### When to use it

A task suits one concrete piece of work that should produce at least one change record and advance through a phase order. Routine single-turn work should not create a task. The service keeps at most one current task per session: an unfinished task must be advanced or cleared before another takes its place, while an accepted task can be replaced directly.

### Setup

Load the package with a composition entry; it takes no configuration.

```yaml
- name: '@deepseek-ai/dsh-delivery'
```

### Session projection

`DeliveryService` requires `ctx.sessionProjections` ([`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.md)) and registers the `delivery` projection unit at startup; a composition that omits the projection registry cannot activate `ctx.delivery`.

### The task lifecycle

A task moves through these durable phases, selected by its level:

| Level | Phase order |
|---|---|
| `l0` | `created → implemented → verified → accepted` |
| `l1` | `created → designed → implemented → verified → accepted` |
| `l2` | `created → designed → specified → implemented → verified → accepted` |

The verbs:

| Operation | What it does |
|---|---|
| `create` | Starts a task in `created` with an objective and optional level |
| `recordChange` | Records one change and increments `changeCount` without changing phase |
| `recordDesign` | Records one design and increments `designCount` without changing phase |
| `recordSpec` | Records one spec and increments `specCount` without changing phase |
| `advance` | Moves to the single legal next phase for the level |
| `clear` | Removes the current task; its history stays in the session log |

### Observing a task

Consumers read the current task with `ctx.delivery.get(agent)` and receive a detached view: objective, phase, level, change, design, and spec counts, and timestamps. Mutations must carry the exact `{ id, revision }` from that view, so a consumer holding older state receives a clear stale-revision error instead of silently overwriting newer state:

```text
const view = ctx.delivery.get(agent)      // undefined when no task is current
view.phase                               // one of the six lifecycle phases
view.level                               // 'l0' | 'l1' | 'l2'
view.changeCount                         // number of recorded changes
view.designCount                         // number of recorded designs
view.specCount                           // number of recorded specs
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Event-sourced state.** Every mutation appends a durable `delivery/change` event (version 1) carrying the complete post-mutation snapshot, an incremental change record, or a clear tombstone. The session log is the only durable authority.
- **Compare-and-set mutations.** `ctx.delivery` accepts only the exact live `Agent` registered under its id. `get()` returns a detached view; mutations take a `DeliveryTaskRef { id, revision }` and reject stale refs.
- **Forward-only phase order.** The fold validates that each `advance` moves to the single legal next phase for the task's level, and rejects skipped phases on replay.
- **Strict replay.** The fold derives the current task only from `delivery/change` and rejects malformed shapes, discontinuous revisions, illegal phase transitions, non-monotonic timestamps, and reused ids.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `DeliveryService`, projection unit, mutations |
| [`src/types.ts`](src/types.ts) | Pure client-safe types: `DeliveryView`, projection-key declaration |
| [`src/domain.ts`](src/domain.ts) | Durable change payloads, `delivery/changed` event |
| [`src/fold.ts`](src/fold.ts) | Strict replay fold and decoder for durable delivery changes |
| [`src/runtime.ts`](src/runtime.ts) | `DeliveryTaskId` brand, `DeliveryError` codes, change version |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: independent incremental fold over every attached session |
| [`src/client.ts`](src/client.ts) | Client-namespace re-export of the types outlet |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Task-state mutations

#### What the model sees

Delivery mutations do not inject model context. The model-facing tools in `dsh-tool-delivery` return the current task state, and the projection exposes it to host consumers.

#### Token effect

Delivery mutation events add no model tokens by themselves. Tool results account for their own visible state.

#### KV Cache effect

There is no KV-cache effect until another component exposes task state in model-visible input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the delivery service is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **One current task** — parallel objectives and a separate task database are intentionally absent; history remains available in the session log after replacement or clear.
- **State, not policy** — this package enforces the phase order but does not decide when a task advances, retry failures, or require a change record before `implemented`; those policies belong to `dsh-tool-delivery`.
- **No artifact persistence** — change records live as durable events only; writing `.dsh/changes/` files is a later consumer's job.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit `delivery/change` data. Strict replay detects malformed or inconsistent records and leaves delivery access failed at that record until the log is repaired.
