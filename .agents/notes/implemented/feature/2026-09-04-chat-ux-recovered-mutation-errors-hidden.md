# Agent Note: A mutation failure a later mutation recovered from no longer stays on the page

Status: implemented

English | [中文](2026-09-04-chat-ux-recovered-mutation-errors-hidden.zh.md)

## Problem

A guarded `edit` / `write` / `str_replace_editor` call that failed with a recoverable code (`FS_NOT_OBSERVED` / `FS_STALE_VERSION`) kept its error row in the transcript even after a later mutation of the same file succeeded. The model-retry projection already hid a recovered request-retry chain by the turn's terminal outcome, but the tool-call surface had no analogue: the `edit requires reading … first — read the file, then retry` failure stayed visible after the model re-read the file and the retry succeeded — including when an intervening `read` sat between the failure and the success.

## Decision

Add `RecoveredMutationProjector` (in `recovered-mutation.ts`), a node projection the Chat snapshot builder runs alongside `ReferenceLabelProjector`. It hides a recoverable mutation failure once a later successful mutation of the same path lands, with the same `replace` / `apply` shape:

- `replace` rebuilds over the whole window: collect the latest successful mutation anchor per path, then hide any recoverable failure whose anchor precedes it.
- `apply` updates incrementally: a newly landed success re-hides earlier recoverable failures of that path by re-evaluating the failures it registered.

Only `FS_NOT_OBSERVED` and `FS_STALE_VERSION` are hidden — the two guarded-mutation codes whose own remedy is "read the file, then retry". Every other failure (e.g. `FS_EDIT_NOT_FOUND`, `FS_PERMISSION_DENIED`) stays visible because it is not transient-by-contract.

### Why hidden, not removed

The row materializes while the call settles, and the assembler forbids withdrawing a materialized node, so the projection marks `visibility: 'hidden'` (the same mechanism the model-retry projection uses) rather than dropping the node.

## Alternatives considered

**Hide inside `toolDefinition.buildViewNode`.** Rejected: coverage needs the later success, which a single tool-call Definition cannot see — its context holds only its own `tool/call` and `tool/result` events.

**Hide in the render layer (`ui-tool`).** Rejected: the visibility decision belongs to the view projection so every consumer of the chat snapshot sees the same recovered state, and no other reader has to re-derive it.

**Hide every failed mutation, not just recoverable codes.** Rejected: a non-transient failure (no-match, permission denied) is meaningful and must stay visible.

## Consequences

A `FS_NOT_OBSERVED` / `FS_STALE_VERSION` mutation failure no longer leaves a stale error row once a later mutation of the same file succeeds, including when an intervening `read` sits between the failure and the success. The decision is render-time only — no schema or session event changes.

## Testing

- `conversation-node-definitions.client.spec.ts` — added four cases: a recoverable failure hidden after a later success with an intervening read; kept visible with no later success; kept visible for a non-recoverable code (`FS_EDIT_NOT_FOUND`); and re-hidden incrementally when the later success lands after the failure. The suite is 48 passing.

## Deferred

None.
