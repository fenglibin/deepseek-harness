---
description: "The delivery package group: one durable change-tracked task per session, plus the model-facing tools that advance it through a disciplined lifecycle."
kind: "package-group"
---

# Delivery discipline

English | [中文](README.zh.md)

## Summary

The `delivery/` group gives one agent session a durable record of the work it is doing: a task with an objective, a size class, and a lifecycle phase that survives session resume, fork, and process restarts because it lives in the session log. The state package keeps the task and enforces its phase order; the tool package decides when a task advances and how strongly the model is held to the discipline. Both are off by default in the sense that no task exists until something creates one. This page maps the group; the package README owns the per-package contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group holds two packages; the package READMEs and the links below own the details.

| Package | What it provides |
|---|---|
| [`delivery/`](delivery/README.md) | The durable task service: create, advance, record against, and clear one compare-and-set task per session |
| [`tool-delivery/`](tool-delivery/README.md) | The model-facing tools and the gate strength deciding when a task may advance |

-----

<a id="related-documentation"></a>
## Related documentation

Read the subsystem page for the durable vocabulary, then the package READMEs for the contracts.

- [Delivery subsystem reference](../../docs/subsystems/delivery.md) — the task identity, phase order, projection, and durable events.
- [Goal subsystem reference](../../docs/subsystems/goal.md) — the neighboring same-session concern the delivery discipline is often confused with: continuation rounds rather than task state.
- [Adding a tool](../../docs/cookbook/adding-a-tool.md) — how the model-facing delivery tools register beside every other tool.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
