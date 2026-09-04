# Agent Note: Delivery-discipline deep self-check

Status: implemented

English | [中文](2026-09-03-delivery-discipline-deep-self-check.zh.md)

## Problem

A deep self-check of batches B1–B3 against the [delivery-discipline design](../../../../docs/design/delivery-discipline-rationale.md) found the domain, fold, projection, state machine, CAS, and gates correct under end-to-end probes, but surfaced three concrete gaps: (1) the §6.4 size proxy implemented only `descriptionChars` and omitted `todoCount`/`touchedFiles` and `requireOpenspecForBugs`; (2) `runtime.ts` carried an `oxlint-disable-next-line` for `no-useless-constructor`, violating the no-lint-suppression rule; (3) there was no end-to-end test walking an `l1`/`l2` task to `accepted` or replacing an accepted task.

## Decision

Close the §6.4 configuration completeness and the two hygiene gaps, without touching the deferred cross-capability work.

- `@deepseek-ai/dsh-tool-delivery` `Config` gains `designThreshold.todoCount` (default `5`), `designThreshold.touchedFiles` (default `3`), `openspecThreshold.todoCount` (default `15`), and `requireOpenspecForBugs` (default `true`). `create_delivery_task` accepts optional `todo_count`, `touched_files`, and `is_bug` estimates; when `level` is omitted, `inferLevel` tiers `l2` at any openspec measure, then `l1` at any design measure, and forces a non-small bug (`is_bug` past the design threshold) to `l2` under `requireOpenspecForBugs`.
- `DeliveryError` drops its `super`-only constructor (the `no-useless-constructor` trigger) in favor of `declare readonly code: DeliveryErrorCode`, removing the only lint-suppression comment in the delivery packages.
- Added end-to-end delivery tests: full `l1` and `l2` lifecycles to `accepted`, accepted-task replacement, and the three new tiering paths.

## Alternatives considered

**Keep `descriptionChars`-only tiering.** Rejected: the design lists three proxies, and a bug-forces-L2 switch, so a single measure under-delivers the §6.4 configurability.

**Restore the `DeliveryError` constructor with the lint suppression.** Rejected: the no-lint-suppression rule is absolute; `declare` narrowing expresses the same type-level intent.

## Consequences

- **Bought** the full §6.4 size-proxy set and `requireOpenspecForBugs`, zero lint suppressions, and end-to-end lifecycle coverage (92 unit tests, 100% coverage).
- **Deferred (unchanged, cross-capability)** — writing `.dsh/changes/` / `.dsh/design/` files and the real `openspec` CLI (`create`/`validate`/`archive`) still need `fs`/subprocess integration; `postHooks` (B4) and client UI (B5) remain future batches.
