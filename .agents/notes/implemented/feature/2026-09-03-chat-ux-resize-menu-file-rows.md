# Agent Note: The composer resizes in every settled phase, the model seat opens on the model list, and file-mutating tool rows carry a rail

Status: implemented

English | [中文](2026-09-03-chat-ux-resize-menu-file-rows.zh.md)

## Problem

Three complaints from everyday use of the Chat surface, all of them about the composer and the transcript around it.

**A fresh session's composer cannot be resized.** Clicking "New session" lands on the centered hero composer, which renders no height handle. A user who just dragged the docked composer to 400px on the previous session gets a fixed-size box on the next one, with no way to repeat the gesture. The two composers are the same input card in two positions, and only one of them answered the drag.

**The model seat costs two clicks to reach a model.** The composer's model trigger opened a two-row root menu — a "Model" row and an "Effort" row, each a label plus its current value plus a chevron — and the actual model list was one drill-in further. Changing a model therefore always cost a second click and a second read of a row that only ever said "Model" and the name already visible on the trigger.

**`write` and `edit` rows look like every other tool row.** In a long transcript, a row that mutated a file renders in the same icon color and the same title color as the `read`, `search`, and `bash` rows around it. The only cue that a file changed lives inside the expanded card, so a reader skimming collapsed rows cannot tell which turns touched the working tree.

## Decision

**The height handle is offered by every settled phase, not only the docked one.** [`ConversationRoot`](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx) renders `HeightHandle` when `phase !== 'settling'` instead of `phase === 'active'`, and [`InputBar.module.css`](../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.module.css) drops the `.hero .scroll { height: auto }` override that made the hero composer ignore the dragged preference. The rest of the height plumbing was already phase-independent and needed no change: `publishSizes()` reads `dsh.conversation.composerHeight` from localStorage and writes `--dsh-composer-user-height` on the root element, and `resolveComposerHeight()` clamps to `[96, root.clientHeight − 240]`. The hero card keeps its own 52px `min-height` floor, so a drag below it still cannot collapse the capsule. The width handles stay docked-only, because the hero phase has no transcript column to size.

**The model seat opens on the model list.** [`ModelSelect`](../../../../packages/client/ui-model-selection/src/client/ModelSelect.tsx)'s `Pane` type loses its `'root'` member; `show()` and `close()` both settle on `'model'`, and `Escape` backs out of `'effort'` to `'model'` before it closes the menu. The effort levels become a row *inside* the model list, placed above the scrolling group container so the current level stays reachable however far the catalog scrolls, and the effort pane gains a back row so a pointer user is not stranded in the drill-in. The `menu.model` key is deleted together with the row it labeled; `menu.back` joins the dictionary for the back row.

**`write` and `edit` rows carry a business-primary rail.** The accent is pure CSS in [`ToolRow.module.css`](../../../../packages/client/ui-tool/src/client/tool/components/ToolRow.module.css), keyed on the `data-variant` attribute `ToolRow` already emits: a 2px left rail in `--dsw-alias-state-business-primary`, the same accent on `.leading`, `.title`, and `.sep`, and a solid hover fill. The rail hangs into the transcript's side padding with `margin-left: -8px`, and a matching `padding-left: 6px` spends it again on the inside — `-8 + 2 + 6 = 0`, so the row's text stays aligned with every other row and the 24px single-line height is untouched.

## Alternatives considered

**Keep the handle docked-only and let the hero composer auto-grow from its content.** Rejected: the complaint is precisely that the two composers behave differently. One preference, one handle, one clamp — the hero card is the same composer in a different position.

**Render the handle in the hero phase but keep `.hero .scroll { height: auto }`.** Rejected: the handle would then move and persist a preference the hero composer silently ignores. A drag with no visible effect is worse than no handle at all.

**Keep the root menu and open the model list on hover over the Model row.** Rejected: hover-to-open is unreachable on touch, and it would add a third interaction model to a menu that already has click and keyboard paths.

**Drop the effort pane and inline the levels in the model list.** Rejected: the effort list is a flat radio group that only applies to the current model. Inlining it pushes the catalog below the fold on every open and puts two radio groups in one `role="menu"`.

**Omit the back row and rely on `Escape` plus re-clicking the trigger.** Rejected: `Escape` is keyboard-only, and re-clicking the trigger closes the menu. A pointer user who drills into the efforts would have no way back to the list.

**Accent file-mutating rows through the leading icon alone.** Rejected: the icon is a 16px glyph. In a transcript where most rows are collapsed and skimmed, a 2px rail running the row's full height reads at a glance where an icon tint does not.

**Indent the row instead of hanging the rail into the gutter.** Rejected: it would offset `write` and `edit` rows 6px from every other row in the same transcript, trading a vertical-alignment break for a horizontal one.

**Use a translucent hover fill.** Rejected: the transcript behind the row would bleed through. `--dsw-alias-interactive-bg-hover-solid` is the token the rest of the client already uses for exactly this.

## Consequences

A user who drags the composer to 400px now sees 400px on the next new session, and the same handle in both presentations. Changing a model is one click to the list and one click on the model; the effort levels are one more row inside that list and one back row out. `write` and `edit` rows are separated from the reads and searches around them by a brand-colored rail, with no change to row height or text alignment.

The cost is one shared preference across two composer presentations: a height dragged for the docked bar now also sizes the hero card. That is what the complaint asked for, but it does mean the hero card can open taller than its content for a user who last dragged a large height. The reset gesture (`onHeightReset`) clears it for both at once.

Item 6 is CSS-only, so no test asserts the rail's pixels. What the tests pin is the hook it depends on: `GenericToolCard` renders `data-variant="edit"` and `data-variant="write"`, already asserted in `tool-row.client.spec.tsx`.

## Testing

- `skeleton.client.spec.tsx` — the hero phase renders the height handle (`data-phase="hero"` and a `[data-height-handle]` in the same tree); the drag → persist round-trip runs on the hero handle (336px base, 376px live at −40, 396 persisted to `dsh.conversation.composerHeight`); the settling phase renders none.
- `model-select.client.spec.tsx` — one click lands on the model list with the effort row inside it; the effort row drills in and the back row returns; `Escape` backs out of the efforts before it closes; reopening after a drilled-in selection lands on the model list rather than the efforts.
- `packages/client` suite: 3850 passed, 1 failed. The failure is `ui-theme/tests/scrollbar-styles.client.spec.ts` on `UserTurnPanel.module.css`, a file this change does not touch — `git diff --stat` over it and over `packages/client/ui-theme` is empty — so it is a pre-existing failure on this branch.
- `tsc -b tsconfig.client.json`, `run-oxlint.ts` over the three packages, and `verify-client-ui-i18n.ts` all pass.

## Deferred

The remaining three items of the same UX pass ship separately: localized output (the language setting does not reach model output today), the changed-files list with accept/reject, and suppressing errors that a retry already resolved. Each is a distinct surface with its own host-side work, and none shares code with this batch.
