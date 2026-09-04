# Agent Note: Delivery-discipline design tiering

Status: implemented

English | [中文](2026-09-03-delivery-discipline-design-tiering.zh.md)

## Problem

B1 gave a session one durable, change-tracked task with a forward-only phase order, but every task started at `l0` by default and the `designed` phase (present in the `l1`/`l2` orders) was unreachable: nothing recorded a design, and nothing required one. A task that should carry a design was indistinguishable from a small fix, and there was no size signal to pick a tier automatically.

## Decision

Extend the delivery domain and tools so a task can carry design records, and so its size class is chosen by a configured proxy rather than only by an explicit `level`.

- `@deepseek-ai/dsh-delivery` gains `DeliverySnapshot.designCount`, a `record-design` operation on `delivery/change` (version 1), and `ctx.delivery.recordDesign(agent, ref, text)`. The strict fold decodes and applies `record-design` like `record-change`: it requires a current task, an exact next revision, a `designCount` that increments by one, and a non-regressing timestamp. `advance` and `create` now also guard `designCount` (create requires zero; advance requires it unchanged).
- `@deepseek-ai/dsh-tool-delivery` gains the `record_design` tool and a `designThreshold.descriptionChars` config (default `300`). `create_delivery_task` infers `l1` when the objective length reaches the threshold and no `level` is supplied, `l0` otherwise; an explicit `level` still overrides. The `advance` gate now requires at least one design record before reaching `designed`, mirroring the existing change-record gate before `implemented`.

This is batch B2 of the [delivery-discipline design](../../../../docs/design/delivery-discipline-rationale.md): the design-document tool, size tiering, and the `designThreshold` gate. The `todoCount`/`touchedFiles` size proxies (which need todo/fs integration) and the openspec split are later batches.

## Alternatives considered

**Reuse the `record_change` operation for designs.** Rejected: a design and a code change are distinct facts with distinct gates; overloading one operation would force callers to encode the distinction in text and complicate the fold.

**Infer the tier from a single fixed threshold with no config.** Rejected: the threshold is deployment-varying (token-rich versus token-poor users), so it must be a validated `Config` field, not a constant.

**Let the model always choose `level` explicitly.** Rejected: models default to the least-effort path, so an automatic proxy plus manual override is what actually produces the right tier without prompting fatigue.

## Consequences

- **Bought** a design record and a `designed` gate, so a larger task is now forced to write a design, and a task's tier is chosen by a configurable size proxy with an explicit override.
- **Cost** a new `record-design` operation and a `designCount` field threaded through the fold, the projection, and every tool result; `designThreshold` adds a config field to validate at `apply`.
- **Deferred** the `todoCount`/`touchedFiles` proxies (they need todo/fs tool integration), the `.dsh/design/` filesystem artifact, and the openspec split (B3); design records remain durable events only.
