# Agent Note: An unsent composer draft keeps its blank Session row listed

Status: implemented

English | [中文](2026-09-03-unsent-draft-keeps-blank-session-row.zh.md)

## Problem

The Workspace browser lists a blank Session only while it is the selected one, so the provisional **New Session** row survives exactly as long as the reader stays on it. Typing a prompt into that row and then opening another Session dropped the row: the typed text stayed in the per-Session draft store keyed by Session id, but no row led back to it, so the only way to finish the thought was to remember the id or start over.

The draft lives in `ui-conversation`; the visibility rule lives in `ui-workspace`. A feature plugin must not runtime-import another feature plugin's values, so the two facts had to meet through an injected service rather than a shared module.

## Decision

`ui-workspace` owns the registry and publishes it as a root-level observable. `UiWorkspaceService` gained `noteDraft(sessionId, draft)` and a `drafts: HostObservable<ReadonlySet<SessionId>>` whose snapshot identity is stable until the membership actually moves; a whitespace-only draft is trimmed to empty and therefore never holds a row, and `deleteSession` prunes the id once the Host accepts the delete. The service's `apply` contributes `sessionDrafts` through `ctx.slots.provideRoot`, so consumers read it as `useSessionDrafts`. `tree.ts` keeps a blank row visible when the set contains it, and `WorkspaceBrowser` threads the hook into the grouped, flat, and search derivations.

`ui-conversation` owns the write: its `bindDraftMirror` inject face now sends every mirrored draft change to both sinks — the per-Session persistence store and `ctx.uiWorkspace.noteDraft` — over the service edge it already injects. `ui-conversation` declares `uiWorkspace` in its `inject`, and `ui-workspace` must not declare `uiConversation` back: that pair would wait on each other forever.

## Alternatives considered

**Let `ui-conversation` publish the root hook itself.** Rejected: a root hook bound only while its provider is mounted gives `materializeStandardBinding` no `useSessionDrafts` key, and the first consumer to render with the hook absent crashes — an activation-order bug rather than a missing fact.

**Have `ui-workspace` read the draft store out of `ui-conversation`.** Rejected: it needs `uiConversation` in `inject`, which closes the cycle above, and it hands the browsing surface a write it does not own.

**Keep the row for any blank Session that was ever typed into.** Rejected: it resurrects rows for drafts that were sent or discarded, which is the behavior the provisional row exists to avoid. The registry is keyed on the live draft, so clearing the composer retires the row.

## Consequences

A blank Session with unsent content stays reachable from every grouping surface and from the flat list, and clearing the composer or deleting the Session retires it. Search still never matches a blank row, so the extra row cannot surface through a query. The registry costs one `Set` copy per membership change, and every browser derivation now takes the set as an argument.
