# Agent Note: Slot abdication is scoped to the Session that crashed

Status: implemented

English | [中文](2026-09-02-scoped-slot-abdication.zh.md)

## Problem

`conversation.composer.bar` is a `single`, `session-maybe` slot registered once per page, so every Session renders the same one registration. A single crash inside that entry — component render or inject factory — retired it for the rest of the registration's life: `SlotCore` kept a `WeakSet` of abdicated entries and excluded them from `entriesOfSlot` permanently, and the only way back was reloading the page. The user-visible result was a composer that vanished from every Session at once and returned only after a refresh, with the typed draft intact because it lives in the per-Session persisted store.

Two transient paths reached that crash. The entry's inject resolved the Session's input shell through `inputHub.shell(id)`, which throws `conversation.input: session "<id>" resolved no binding` whenever the binding is momentarily unresolvable — the window in which a created Session is still activating, or a switching Session is rebuilding its scope. And the composer's contenteditable could bind a root element to a shell whose Session scope had already disposed it.

The crash face made both paths silent: an empty `<div data-slot-error="…">` is indistinguishable from a slot nobody filled.

## Decision

Abdication is scoped. `SlotCore` records the scope each crash retired an entry under — a `WeakMap<StoredEntry, string>` rather than a `WeakSet` — `entriesOfSlot(key, scope)` skips an entry only while that same scope renders, and `reportEntryError` carries the scope in its `info`. A root-scoped render retires under `ABDICATION_SCOPE_ROOT`; a Session render retires under `abdicationScopeOf(binding.key)`, so the next Session renders the entry again. Switching away from a crashed Session and back keeps that retirement, so a Session whose composer is genuinely broken cannot crash in a loop.

The renderer derives the scope from the slot's declared scope and the binding it renders — `root` retires under the root scope even when it renders inside a Session subtree — and passes it to both the projection and the crash report.

The crash face is `SlotCrashFace`, shared by entry boundaries and dry-cell projections. Official builds keep the bare `[data-slot-error]` marker; local builds (any `DSH_CLIENT_BUILD_PROFILE` other than `official`) plate it with the slot key, a code token, so a hole in the tree is visible without introducing product copy.

Composer chrome stops feeding both paths. `InputHub.tryShell(id)` answers `undefined` while a Session's binding is unresolvable, while `shell(id)` — the programmatic path whose caller owns an addressable Session — still throws. The composer bar's inject degrades to the inert face it already uses for no-Session, and a rebuilt scope re-runs the inject on its new binding. `SessionInputShell` publishes `live`, false after `dispose()`, and `InputBar` withholds a disposed shell's editor: `editor: null` reaches `ComposerContentEditable`, which already renders that state inert and binds no root element.

## Alternatives considered

**Retry on every re-render instead of per Session.** Clearing the retirement whenever an outlet re-projects would retry a genuinely broken entry on every unrelated re-render and produce a crash-log loop. Keying by scope retries once per Session change.

**Keep the global retirement and let registrations opt out.** A per-slot flag would push a framework invariant onto every registrant, and the registrant that needs it is exactly the one that cannot know it crashed.

**Show the crash face in official builds too.** A visible plate needs localized copy; the local-build gate keeps the diagnostic without shipping untranslated text or framework chrome to production users.

**Return a no-op shell instead of degrading at the inject.** A stand-in shell would have to fake the editor, submit, and notice channels. The bar's inert face already exists and is honest about there being no input.

## Consequences

A crash that used to cost the composer for every Session until a reload now costs one Session until the next switch, and in local builds the crash face names the slot that failed. Registrations that crash in the root scope still stay retired until disposed — unchanged, and correct, since nothing narrower can retry them.

The composer can now render inert for a Session whose input shell is unreachable, a visible state where it previously disappeared; that state ends when the scope rebuilds. `ComposerKeyboard` gained `live`, a package-internal contract that never crosses a plugin boundary.

## Testing

`packages/client/ui-slots/tests/core.client.spec.ts` pins the storage semantics: retired in the reported scope only, chain entries never retired, an omitted scope retires under root. `packages/client/ui-renderer/tests/scoped-slots.client.spec.tsx` drives a `session-maybe` entry through a crash under one Session, asserts the next Session renders it again, and asserts the reported and projected scopes; a second case pins both crash-face profiles. `packages/client/ui-conversation/tests/apply-inject.client.spec.tsx` asserts a ghost-Session inject degrades to the inert face, and `tests/input-bar.client.spec.tsx` asserts a disposed shell leaves the composer inert.
