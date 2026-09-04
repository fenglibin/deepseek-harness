# Agent Note: Delivery-discipline timeline node and floating card

Status: implemented

English | [中文](2026-09-04-delivery-timeline-and-float-card.zh.md)

## Problem

The B5 `DeliveryDock` surfaced the delivery task as a read-only strip in the `conversation.input.dock` above the composer. Two defects followed. First, that placement was wrong for the design's §6.6: the task belongs in the conversation timeline as a durable card, and as a floating card pinned to the body's left edge — not as a composer dock. Second, a dock shows only the current snapshot, so a task whose phase advanced read as static; the user saw "已创建 → 已拆分" only after an hour because there was no per-mutation timeline to follow.

## Decision

Replace `DeliveryDock` with two surfaces, both read-only:

- A durable **timeline card**: a `ConversationNodeDefinition` (`delivery-task`) folds the `delivery/change` session event family into one keyed Chat node. Each `create` opens the node; each `advance` / `record-*` / `clear` update folds into its state, so the card follows the task lifecycle in the transcript and re-renders on every mutation (live, not snapshot). Rendered by `DeliveryTaskPanel` through the `conversation.chat.node` keyed seat.
- A **floating card**: `DeliveryFloatCard` registers on a new session-scoped `conversation.side.float` slot, declared by `ui-conversation` and rendered on the body's left edge. It reads the `delivery` projection and shows the tier badge, phase, and objective collapsed; expanding reveals the phase progress bar and artifact paths.

To let the client read `delivery/change` event data, the durable change vocabulary (`DeliveryChangeMeta`, its `Delivery*Meta` members, `DeliveryOperation`, `FoldedDelivery`, `DeliveryErrorCode`) and the `SessionEventMap['delivery/change']` merge moved from host-side `domain.ts` into the client-safe `types.ts` outlet. `domain.ts` keeps only `DeliveryChanged` and the scoped `delivery/changed` cordis event.

## Alternatives considered

**Keep the dock and add the two surfaces beside it.** Rejected: the user asked to replace, not accumulate; three concurrent task surfaces over one task is noise.

**Read the timeline from the projection.** Rejected: the `delivery` projection is a single current snapshot; a timeline requires folding the `delivery/change` events, which the Conversation node machinery already does incrementally.

**Mount the floating card on `shell.overlay`.** Rejected: `shell.overlay` is root-scoped, so its occupants receive no `useProjection`; the card needs the session projection, hence a session-scoped slot.

## Consequences

- **Bought** a live, in-transcript task card that re-renders on every delivery mutation, plus a persistent left-edge floating card over the current task. The composer dock is gone.
- **Cost** a new session-scoped `conversation.side.float` slot (declared in `ui-conversation`'s `slots.ts`, `apply.ts`, and rendered by `ConversationRoot`), a `ConversationNodeDefinition`, and the delivery type relocation into the client-safe outlet.
- **Moved** the `delivery/change` vocabulary into `types.ts`; `fold.ts`, `runtime.ts`, and `index.ts` now import it from `types.ts` instead of `domain.ts`. No package-root re-exports changed, so host consumers are unaffected.

## Verification findings

A post-implementation review of the two surfaces against the request — place the card in the conversation by time, float it at the left edge, and keep both live as the task advances — checked behaviour rather than compilation, and fixed two defects.

- **Card posture did not follow the task.** `DeliveryTaskPanel` seeded its expanded state from props once, so a task that later reached `accepted` or was cleared kept whatever posture it had at creation. It now derives a `settled` flag and re-settles on the boundary, with tests covering both the accepted and the cleared transition.
- **The cards used the wrong theme scale.** Both stylesheets inherited `--vscode-*` custom properties from the deleted dock. Every other client module (195 of 197) uses `--dsw-alias-*`, so those variables are undefined under the app theme and fell back to hard-coded light values — wrong in dark mode. Both files now use `--dsw-alias-*` colours, `--dsw-shadow-lv2`/`lv3`, and `--ds-font-family-code`.

Three behaviours were confirmed correct rather than changed. The card renders through the keyed path — `ChatView` maps `order` to `ChatNodeSeat`, which dispatches to the `conversation.chat.node` seat by node kind — so the `default` branch of `legacyContribution`, which returns an empty contribution for unknown kinds, does not hide it. Ordering follows `anchorSeq`, which the Node sets to the create event's seq. And liveness holds because `ChatNodeSeat` subscribes to the node by key and every `update` returns a fresh state object; an appended-event test now pins this, since the earlier tests only covered one-shot replay.

Two gaps remain and are recorded in the package README rather than fixed here: artifact *content* preview needs the host to project `fs` reads to the client, and gate pass/failure plus post-hook results have no durable events to replay as timeline entries.
