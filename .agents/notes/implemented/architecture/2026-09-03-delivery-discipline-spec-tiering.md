# Agent Note: Delivery-discipline spec tiering

Status: implemented

English | [中文](2026-09-03-delivery-discipline-spec-tiering.zh.md)

## Problem

B1 and B2 gave a session a change-tracked task with a forward-only phase order plus a design record and a `designed` gate, but the `specified` phase (present in the `l2` order) was still unreachable: nothing recorded a spec, nothing required one, and the `l2` tier had no automatic size signal.

## Decision

Extend the delivery domain and tools so an `l2` task carries spec records, and so its size class can auto-tier to `l2` through a second configured proxy.

- `@deepseek-ai/dsh-delivery` gains `DeliverySnapshot.specCount`, a `record-spec` operation on `delivery/change` (version 1), and `ctx.delivery.recordSpec(agent, ref, text)`. The strict fold decodes and applies `record-spec` exactly like `record-change`/`record-design`: it requires a current task, an exact next revision, a `specCount` that increments by one, and a non-regressing timestamp. `create` and `advance` now also guard `specCount` (create requires zero; advance requires it unchanged).
- `@deepseek-ai/dsh-tool-delivery` gains the `record_spec` tool and an `openspecThreshold.descriptionChars` config (default `1200`). `create_delivery_task` infers `l2` when the objective length reaches that threshold and no `level` is supplied, `l1` at the design threshold, `l0` otherwise; an explicit `level` still overrides. The `advance` gate now requires at least one spec record before reaching `specified`, mirroring the change- and design-record gates.

This is batch B3 of the [delivery-discipline design](../../../../docs/design/delivery-discipline-rationale.md): the spec record, the `specified` gate, and the `openspecThreshold` tier. The real `openspec` CLI integration (writing `openspec/` files and running `openspec validate`) belongs to B4's post-hook framework.

## Alternatives considered

**Reuse the `record_design` operation for specs.** Rejected: a spec and a design are distinct facts with distinct gates; overloading one operation would force callers to encode the distinction in text.

**Fold the openspec CLI into the tool now.** Rejected: spawning `openspec validate` is a post-execution command, which B4 owns; recording a spec is the durable fact the domain needs first.

**Tier to `l2` with a fixed threshold and no config.** Rejected: the threshold is deployment-varying, so it is a validated `Config` field like the design threshold.

## Consequences

- **Bought** a spec record and a `specified` gate, so an `l2` task is now forced to record a spec, and its tier is chosen by a second configurable size proxy with an explicit override.
- **Cost** a new `record-spec` operation and a `specCount` field threaded through the fold, the projection, and every tool result; `openspecThreshold` adds a config field to validate at `apply`.
- **Deferred** the real `openspec` CLI integration (writing `openspec/` files and running `openspec validate`) and the `.dsh/changes/`/`.dsh/design/` filesystem artifacts; spec records remain durable events only.
