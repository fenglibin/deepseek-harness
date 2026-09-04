---
description: "The model-facing delivery-discipline tools: create, read, record changes, designs, and specs against, and advance a same-session delivery task under a configurable gate strength."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-delivery

English | [中文](README.zh.md)

## Summary

`dsh-tool-delivery` gives the agent six tools over the persisted same-session delivery task: `get_delivery_task` reads the current task, `create_delivery_task` starts one (auto-tiering its `level` from the objective length), `record_change` records one change against it, `record_design` records one design against it, `record_spec` records one spec against it, and `advance_delivery_task` moves it to the next phase. The gate strength is a deployment choice: `stateful` (default) blocks advancing to `implemented` before at least one change record exists, to `designed` before at least one design record exists, and to `specified` before at least one spec record exists; `advisory` reminds instead of blocking, and `off` (or `enabled: false`) registers no tools at all. Use it wherever the agent should keep a visible, change-tracked task that advances through a disciplined lifecycle.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside the delivery service and the tool registry; the tools then appear in the conversation.

```yaml
- name: '@deepseek-ai/dsh-delivery'
- name: '@deepseek-ai/dsh-tool-delivery'
  config:
    enforcement: stateful
    designThreshold:
      todoCount: 5
      descriptionChars: 300
      touchedFiles: 3
    openspecThreshold:
      todoCount: 15
      descriptionChars: 1200
    requireOpenspecForBugs: true
    postHooks:
      - 'openspec validate --strict'
      - 'pnpm run test'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the tools are registered at all |
| `enforcement` | `stateful` | `stateful` blocks, `advisory` reminds, `off` registers nothing |
| `designThreshold.todoCount` | `5` | Estimated todo count at or above which a task auto-tiers to `l1` |
| `designThreshold.descriptionChars` | `300` | Objective length at or above which a task auto-tiers to `l1` |
| `designThreshold.touchedFiles` | `3` | Estimated changed-file count at or above which a task auto-tiers to `l1` |
| `openspecThreshold.todoCount` | `15` | Estimated todo count at or above which a task auto-tiers to `l2` |
| `openspecThreshold.descriptionChars` | `1200` | Objective length at or above which a task auto-tiers to `l2` |
| `requireOpenspecForBugs` | `true` | A non-small bug fix (past the design threshold) forces `l2` |
| `postHooks` | `[]` | Post-execution commands run (in order) before a task may reach accepted |

### What each call does

- `create_delivery_task` starts a task in `created` with an objective and optional `level` (`l0`/`l1`/`l2`); when `level` is omitted, it is inferred from the objective length plus optional `todo_count` and `touched_files` estimates, and a bug (`is_bug`) may force `l2`.
- `record_change` records one change (`text`) against the exact `{ task_id, revision }`, increments the change count, and appends the record to `.dsh/changes/<task-id>.md`.
- `record_design` records one design (`text`) against the exact `{ task_id, revision }`, increments the design count, and appends the record to `.dsh/design/<task-id>.md`.
- `record_spec` records one spec (`text`) against the exact `{ task_id, revision }`, increments the spec count, and appends the record to `openspec/changes/<task-id>/spec.md`.
- `advance_delivery_task` moves the task to the single legal next phase for its level; a skip is rejected.
- `get_delivery_task` reads the current task including its exact id/revision.

Under `stateful`, `advance_delivery_task` to `implemented` is blocked until at least one change record exists, to `designed` until at least one design record exists, and to `specified` until at least one spec record exists; under `advisory`, the same conditions produce an in-conversation reminder but do not block.

Before a task reaches `accepted`, every configured `postHooks` command runs in order against the session working directory. Under `stateful`, any non-zero exit, timeout, or abort blocks acceptance; under `advisory`, the failure is surfaced as a reminder but acceptance proceeds.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Service-backed, policy-owned gate.** The tools are thin adapters over `ctx.delivery`; the phase-order validation lives in the domain, while the change- and design-record prerequisites and the size tier are a deployment policy resolved in `apply` and checked before `advance` (and at `create` for the tier).
- **Fail-loud config.** `enabled` and `enforcement` are validated at `apply`; an unknown enforcement value throws rather than silently defaulting.
- **No independent state.** The tools own no durable state; the delivery domain and its strict replay are the only authority.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, tool registration, gate logic |
| [`src/invariant.ts`](src/invariant.ts) | No-runtime invariant companion |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas and results

#### What the model sees

The generated [`get_delivery_task`, `create_delivery_task`, `record_change`, `record_design`, `record_spec`, and `advance_delivery_task` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-delivery). Each returns a compact JSON object: `{ task: null }` before a task exists, or `{ task: { id, revision, objective, phase, level, changeCount, designCount, specCount, createdAt, updatedAt } }`.

#### Token effect

Each executed tool adds its data-dependent JSON result through the ordinary tool-result pipeline; there is no private truncation.

#### KV Cache effect

The schemas remain prefix-stable while their definitions and scope stay unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tools are a poor fit. They are current package constraints, not a task backlog.

- **Records persist as durable events plus `.dsh/`/`openspec/` files** — each record appends to `.dsh/changes/<task-id>.md`, `.dsh/design/<task-id>.md`, or `openspec/changes/<task-id>/spec.md`; the full openspec change layout (proposal/design/tasks/specs) and `openspec validate` CLI are later batch work.
- **Gate is per-advance, not continuous** — a task created before the prerequisite policy changed is only re-checked at its next `advance`.
- **Single-owner scope only** — the task belongs to one agent session; subagent and shared scopes are out of scope.
