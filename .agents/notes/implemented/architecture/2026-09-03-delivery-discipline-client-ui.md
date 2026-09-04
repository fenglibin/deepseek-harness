# Agent Note: Delivery-discipline client UI

Status: implemented

English | [中文](2026-09-03-delivery-discipline-client-ui.zh.md)

## Problem

B1–B4 delivered the task domain, tools, gates, artifact persistence, and post-hooks, but the Web GUI surfaced none of it: a user had no visible tier, phase, or artifact list for the current delivery task, so the design's "make every phase visible" goal (§2, §6.6) was unmet.

## Decision

Add a read-only `@deepseek-ai/dsh-client-ui-delivery` surface plugin whose `DeliveryDock` registers on the `conversation.input.dock` strip and reads the host-computed `delivery` projection through the session standard `useProjection` seat.

- The dock shows the size tier (`L0`/`L1`/`L2`), the lifecycle phase, the truncated objective, and an artifact count whose tooltip lists the exact paths derived from the snapshot's `changeCount`/`designCount`/`specCount` (`.dsh/changes/<id>.md`, `.dsh/design/<id>.md`, `openspec/changes/<id>/spec.md`).
- Loading (`undefined`) and no-current-task (`null`) render nothing, and there are no mutation verbs — the task advances through the model-facing tools, so the surface owns no store and emits no events. The Web preset mounts it after `ui-goal`.

This is batch B5 of the [delivery-discipline design](../../../../docs/design/delivery-discipline-rationale.md): the projection-backed client UI. The `delivery` session projection itself shipped in B1.

## Alternatives considered

**Show the task inside the conversation timeline.** Rejected: the design's §6.6 sidebar/card and artifact preview are a persistent dock concern, and the input-dock strip is the established seat for goal/session-changes surfaces.

**Add accept/clear/advance verbs to the strip.** Rejected: mutations belong to the model-facing tools; a read-only surface avoids duplicating CAS logic in the client.

**Introduce a `delivery/artifact-written` event for the artifact list.** Rejected for this batch: the record tools write deterministic paths, so the list derives from record counts; the event remains deferred until the model can write arbitrary `openspec/` files.

## Consequences

- **Bought** a visible delivery surface: tier badge, a phase progress bar over the tier's required phases, the next gate prerequisite when unmet, and the artifact paths (20 jsdom tests, 100% coverage).
- **Cost** a new client package (locale dictionaries, dock registration, tsconfig/base/client + bundle wiring) and a `delivery` projection key consumed by `useProjection`.
- **Deferred (unchanged)** the `delivery/artifact-written` session-event projection, a live artifact content preview pane, the conversation timeline node for phase transitions / gate pass-failure / post-hook results (its replay requires making gate and post-hook outcomes durable events), and a config settings card.
