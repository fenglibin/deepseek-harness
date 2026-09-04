# Agent Note: A session changed-files dock lists the agent's mutations with per-file accept

Status: implemented

English | [中文](2026-09-03-chat-ux-session-changes-dock.zh.md)

## Problem

There was no way to see, in one place, which files the agent had mutated this session. The per-turn produced-files row (`ui-deliverables`) names the outputs of a single closing turn, but nothing folded them across turns, and nothing offered the accept action the request asked for.

## Decision

Add a new package `packages/client/ui-session-changes` that contributes one entry to the existing `conversation.input.dock` strip (above the composer, before the todo and goal docks). The entry folds the per-turn `deliverables` vocabulary — which `ui-deliverables` already accumulates from successful `write` / `edit` / `str_replace_editor` calls — into one session-wide, first-seen list, and renders a collapse/expand card with a per-file accept button and a bulk accept.

**The data layer gained an operation kind.** `turn-deliverables.ts` now records a `MutationOperation` (`'write' | 'edit'`) beside each produced path — `write` maps to `'write'`, `edit` and `str_replace_editor` map to `'edit'` — via a new `mutationTarget()` resolver and a `producedChangesForClosing()` reader. The existing `producedForClosing()` is unchanged, so the turn-tail chip keeps working; `producedChangesForClosing()` is the same de-dup, first-seen fold but returns `{ path, operation }` for the session surface.

**The UI reads the conversation, not a new projection.** `SessionChangesDock` (the adapter) subscribes through the session-standard `useConversation` seat, folds `conversation.views.get('chat').timeline.turns` with `producedChangesForClosing`, and renders a pure `SessionChangesPanel`. The panel owns component-local accept state: accepting a file removes it from the list only — nothing on disk changes. The pure panel / adapter split mirrors `ui-goal`'s `GoalBar` / `GoalDock`, so the panel is testable without the `InputZone` owner share.

**Reject is deliberately absent.** There is no per-call prior-content snapshot under the FS tools, so a real rollback is impossible; the confirmed scope is accept-only.

## Alternatives considered

**A new session-scoped `ConversationNodeDefinition`.** Rejected: `deliverables` already publishes the per-turn mutations through `buildLocationData`, and the assembler's start/update contract has no natural session-level start event. Folding the already-published turn data in the UI is simpler and reads the same source of truth.

**A session projection (like `todos`).** Rejected: it would add a host-side accumulator for data the conversation timeline already carries, for one consumer.

**Accept persisted to settings.** Rejected: the confirmed scope is a surface-only dismissal; component-local state keeps the change small and reversible.

**A real reject (rollback).** Rejected: no snapshot exists, and the user confirmed "先不做拒绝".

## Consequences

A session that mutated files now shows a docked "本次修改的文件 / Changed files" card: collapsed it reads the count, expanded it lists each file (basename + operation + accept), with a bulk accept. Accepting clears the entry from the surface without touching disk; the dock disappears once every file is accepted. The list de-duplicates a file written and then edited into one first-seen entry, keeping the earliest operation kind.

The cost is one more input-dock entry above the composer, and a component-local accept set that resets when the page reloads (a reload re-shows accepted files). Both are the intended v1 trade-offs.

## Testing

- `ui-deliverables/tests/produced-files.client.spec.tsx` — added a test that `producedChangesForClosing` records `write` / `edit` / `edit` for `write`, `edit`, and `str_replace_editor` respectively, and returns `[]` for absent data. The package is 32 tests.
- `ui-session-changes/tests/session-changes-dock.client.spec.tsx` — 7 tests: the fold (first-seen across turns, earliest operation kept, no chat view / empty timeline / no deliverables), collapse-by-default then expand, per-file accept, and bulk accept hiding the dock.
- Both packages: 39 passed, 0 failed; lint 0 warnings/errors; `tsc -b tsconfig.client.json` clean for the new package.

## Deferred

The remaining item of the same UX pass is out of scope: none. This closes the six-item pass; the changed-files list was the last item.
