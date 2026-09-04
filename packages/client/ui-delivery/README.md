---
description: "Delivery-discipline surface for the Web GUI: a durable task timeline card in the conversation plus a floating task card pinned to the body's left edge, showing the current task's size tier, lifecycle phase, mutation timeline, and produced artifact paths; for users and maintainers of the delivery-discipline experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-delivery

English | [中文](README.zh.md)

## Summary

This package renders the delivery-discipline surface in the Web GUI as two read-only views. The durable **timeline card** folds the `delivery/change` session events into a keyed Conversation node, so the task card appears in the transcript at its create event and re-renders on every mutation (phase transitions and each change/design/spec record). The **floating card** is pinned to the conversation body's left edge and shows the current task's size tier (`L0`/`L1`/`L2`), its phase, the truncated objective, and — when expanded — a phase progress bar over the tier's required phases plus the artifact paths the record tools have written (`.dsh/changes/<id>.md`, `.dsh/design/<id>.md`, `openspec/changes/<id>/spec.md`). The floating card reads the live task from the host-computed `delivery` projection; both views are read-only — the task is advanced through the model-facing tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation` and the `@deepseek-ai/dsh-delivery` domain package. The timeline card then appears in the transcript for each delivery task the model creates, and the floating card appears at the conversation body's left edge whenever the session has a current task. Loading and no-current-task render nothing, so a session outside the delivery discipline shows no extra chrome.

### Timeline card

The card follows the task's lifecycle in the transcript: a `create` opens it, and every `advance` / `record-change` / `record-design` / `record-spec` / `clear` appends a timeline entry, so the phase progress and record counts update live as the model works.

### Floating card, phase progress, and gate hint

The floating card shows a progress bar over exactly the phases the task's tier requires (L0 skips design and split, L1 skips the split, L2 walks the full order), marking completed, current, and upcoming steps. While the next phase's prerequisite record is missing, a gate hint states what is required next (change, design, or spec).

### Artifact list

The floating card lists the artifact paths only when at least one record exists, derived from the task's `changeCount`/`designCount`/`specCount`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The timeline card is event-mode: `deliveryTaskDefinition` folds `delivery/change` session events into one keyed Chat node, registered on `conversation.chat.node`. The floating card is projection-mode: the live task arrives through `useProjection('delivery')` (seeded by the history tail page and updated by `session/projection` frames), registered on the session-scoped `conversation.side.float` slot. The artifact paths are derived from the projected snapshot's record counts, so the plugin owns no durable state and emits no events; disposal rides the plugin fiber (HMR safety).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the delivery strip is not enough.

- [dsh-delivery](../../delivery/delivery/README.md) — the delivery domain, projection, and lifecycle this surface reads.
- [dsh-tool-delivery](../../delivery/tool-delivery/README.md) — the model-facing tools that advance the task and write the artifacts.
- [ui-conversation](../ui-conversation/README.md) — declares the `conversation.side.float` and `conversation.chat.node` slots and owns the composer.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current delivery surface. They are current package constraints, not a task backlog.

- **Derived artifacts only** — the surface reconstructs artifact paths from record counts; there is no `delivery/artifact-written` session event, so artifacts the model writes outside the record tools (for example a hand-written `openspec/` change) are not listed.
- **No gate-pass/failure or post-hook timeline entries** — the timeline card shows creation, phase transitions, and each record, but gate pass/failure and post-hook results do not yet render as nodes; the events those nodes would replay are not yet durable.
- **No artifact content preview** — the surface lists paths, not read-only file contents; a content preview needs the host to project `fs` reads into the client.
- **No config settings card** — the thresholds, switches, and `postHooks` are not yet editable from a settings surface.
- **Read-only surface** — the task is advanced through the model-facing tools, not this surface; there are no accept/clear/advance verbs here.
