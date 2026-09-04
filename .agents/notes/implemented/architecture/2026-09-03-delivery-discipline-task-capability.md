# Agent Note: Delivery-discipline task capability

Status: implemented

English | [中文](2026-09-03-delivery-discipline-task-capability.zh.md)

## Problem

An agent in the harness executes work freely: it can edit code and claim completion without producing any change record, design, or task breakdown, and nothing programmatically stops it from skipping a required phase. Prompt-only constraints ("please self-check") are unreliable because the model can assent without acting. The result is untraceable, unverifiable, and uncontrolled work, with no configurable strength to suit token-rich versus token-poor users.

## Decision

Ship a `delivery` capability as two packages — a service and its model-facing tools — that give a session one durable, change-tracked task with a forward-only phase order.

- `@deepseek-ai/dsh-delivery` (`packages/delivery/delivery/`) owns the `DeliveryTask` domain as an event-sourced service. `ctx.delivery` supports `create`, `advance`, `recordChange`, and `clear` with compare-and-set `{ id, revision }` refs, appends `delivery/change` (version 1) session events, and registers the strict `delivery` session-projection unit plus an invariant companion. The fold rejects malformed shapes, discontinuous revisions, skipped phases, timestamp regressions, and id reuse.
- `@deepseek-ai/dsh-tool-delivery` (`packages/delivery/tool-delivery/`) registers `get_delivery_task`, `create_delivery_task`, `record_change`, and `advance_delivery_task`. Its `enforcement` config selects the gate: `stateful` (default) blocks advancing to `implemented` before at least one change record, `advisory` reminds instead of blocking, and `off` (or `enabled: false`) registers no tools.
- A task carries a size class — `l0` (`created → implemented → verified → accepted`), `l1` (adds `designed`), `l2` (adds `specified`) — and the phase order is enforced by the domain, not the tool layer.
- The capability is mounted in the base bundle beside `goal` with `enforcement: stateful`.

This is batch B1 of the [delivery-discipline design](../../../../docs/design/delivery-discipline-rationale.md): the task domain, phase state machine, change records as durable events, and the configurable gate. Artifact persistence to `.dsh/changes/`, the `design` phase gate, and the openspec split are later batches.

## Alternatives considered

**Reuse `goal` as the task carrier.** Rejected: `goal` is a single long-running objective with round-based continuation and its own phase vocabulary; delivery needs a distinct phase order and a change-count fact, and forcing it onto goal would distort both domains.

**Compose `plan-mode` + `tool-todo` + `workflow` with a thin gate.** Rejected: `tool-todo` is whole-list replace (unsuited to an openspec split) and `plan-mode` is guidance, not enforcement; a gate over them would carry their semantic mismatches.

**Build only a minimal change-record layer first.** Rejected: without a domain model and state machine, later design and openspec batches would require a rewrite.

## Consequences

- **Bought** a durable, strictly-replayed task state machine with a configurable gate strength, giving the first programmatic enforcement point against model drift.
- **Cost** a new event type (`delivery/change`) and projection key, plus a new enforcement paradigm alongside the harness's guidance-first posture — accepted because the gate only blocks the `advance` to `implemented`, never exploratory tool use.
- **Deferred** artifact persistence (`.dsh/changes/` files), the `design` phase gate (B2), and the openspec split (B3); change records are durable events only for now.
