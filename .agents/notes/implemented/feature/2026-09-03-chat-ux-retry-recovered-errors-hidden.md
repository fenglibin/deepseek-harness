# Agent Note: A retry the turn recovered from no longer leaves its failure on the page

Status: implemented

English | [中文](2026-09-03-chat-ux-retry-recovered-errors-hidden.zh.md)

## Problem

When a model request failed, was retried, and the retry succeeded, the transcript still showed the recovered failure. The `model-retry` node materialized whenever `attempts.length > 0`, and `ModelRetryItem` put the failure detail (`node.failure.message`) inside a `<details>` that stayed in the transcript after the turn closed cleanly. A user who had already gotten an answer still saw "报错" from the transient failure that was never a problem again.

## Decision

Gate the `model-retry` node on the owning turn's terminal outcome, at render time in [`retry.ts`](../../../../packages/client/ui-chat/src/client/conversation-nodes/retry.ts). `buildViewNode` now reads the turn from its location and checks its ending:

- **Turn closed with a non-error reason** (`completed`, `aborted`, `interrupted`, `max-tokens`, …): the retry chain did not end in a terminal failure, so the node's failure detail must not render. The node is returned with `visibility: 'hidden'`.
- **Turn closed with `reason.kind === 'error'`**: the retry chain did not resolve the failure, so the node renders as before; the sibling `turn-error` node already carries the terminal row.
- **Turn still open, or its ending unresolved**: the neutral "retrying / started" state still renders, so the user sees a retry is happening while the turn has not proven it recovered.

### Why hidden, not null

The first implementation returned `null` for a recovered turn. That is wrong for a live turn: the `model-retry` node materializes while the turn is open (the "retrying" state), and the `ConversationNodeAssembler` forbids a Definition from withdrawing a materialized node — it throws `"… withdrew materialized target \"chat\"; return the same key with hidden visibility instead"`. The correct representation of "present but not shown" is `visibility: 'hidden'`, which `chatNode` already supports, so the node stays on the timeline but never reaches the rendered order.

## Alternatives considered

**Return `null` for a recovered turn.** Rejected: it throws the assembler's withdraw guard on the live path (open → closed), because the neutral retry state had already materialized. Only a fresh replay that never saw the open state tolerates `null`.

**Hide the `turn-error` node instead.** Rejected: `turn-error` is only produced for `reason.kind === 'error'`, so a recovered turn has no `turn-error` to hide. The offending surface is the `model-retry` chain, not the terminal row.

**Auto-dismiss the composer error toast on recovery.** Rejected: the toast (`InputBar` `promptError` / `notices`) is a separate channel from the retry chain and would hide genuine send failures. Out of the confirmed scope.

## Consequences

A turn that recovered from a retry now shows its answer with no leftover failure detail; the `model-retry` node is hidden, and no `turn-error` row exists. A turn that still failed keeps the visible `model-retry` chain and its `turn-error` row. The change is one render-time decision with no schema or event change.

The cost is a hidden `model-retry` node retained on the timeline for every recovered turn, which is what the assembler's no-withdraw contract requires. It never renders, so there is no user-visible difference; it only means `value.nodes` still contains the node with `visibility: 'hidden'`.

## Testing

- `conversation-node-definitions.client.spec.ts` — added `hides a retry chain whose turn closed without error (the retry recovered)`, which assembles a full `turn/start → step/start → llm/retry → llm/retry-started → assistant/message → step/end → turn/end(completed)` sequence and asserts `model-retry` is `hidden` and `turn-error` is absent.
- Existing retry tests still pass: the exhausted-retry chain (`turn/end` `reason.kind === 'error'`) renders visible attempts, and the open-turn case renders the neutral state.
- `packages/client/ui-chat` suite: 311 passed, 0 failed.
- `tsc -b tsconfig.client.json` and lint pass.

## Deferred

The last item of the same UX pass stays separate: the changed-files list with accept/reject.
