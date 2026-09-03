# Agent Note: Chat flow rows name the file operation, stream the reasoning, and cap command output

Status: implemented

English | [中文](2026-09-02-standard-mode-flow-row-disclosure.zh.md)

## Problem

The Chat view — the `conversation.view` entry registered as `id: 'chat'` at order 0 by `packages/client/ui-chat/src/client/apply.ts`, which is what the product calls the standard mode — asked the reader to infer four things the row already knew.

A file-mutation row printed the path and the `+n -n` totals but never said **what it did** to the file. `ToolRow` derived its title from the tool variant alone, so a `write` that created a file and an `edit` that rewrote one read alike until expanded: the only difference was whether the diff's first hunk carried a previous revision, and nothing surfaced that.

Reaching the diff meant finding the chevron. `DisclosureRow` already made the whole row the toggle, but a chevron alone says "there is more here" without saying *what*, so the row gave no answer to "did it change what I think it changed".

A reasoning block was worse than silent: it opened **collapsed**, showing one line — the newest while streaming, the first once settled. A reader who wanted to watch the model think had to click, and the streaming summary was a single ellipsized line scrolling sideways, not the thought.

A Bash row sat at the other extreme. Closed, it showed nothing but its summary; open, it rendered the terminal card with `maxLines={Infinity}` and no height cap, so a command printing two hundred lines pushed the reply — and every row beneath it — off the viewport while it streamed.

## Decision

**A file-mutation row names its operation beside the path.** `diff-card-model.ts` gained `FileOperation` (`added` | `modified` | `deleted`) and `fileOperation(toolName, diffs)`, derived from the hunks the row actually presents: a hunk whose `oldText` is null means the file had no previous revision, so every hunk carrying one is a modification and any hunk without is a creation. `DiffCardModel` carries the result as `operation`, and `ToolRow` renders it through `OPERATION_KEYS`, a `satisfies Record<FileOperation, LocaleKeysOf<'conversation'>>` map so a missing dictionary entry is a compile error rather than a blank.

`deleted` is reserved, not reachable: `intendedDiff` returns null for every wire name that is not a mutation tool, so `diffCardModel` yields no card — and therefore no operation — for a delete. The dictionaries carry the label anyway, which makes adopting a delete tool a change to `intendedDiff` in that module rather than a change to the row. An earlier draft of this note claimed the row would need no change; that was wrong, and the classification carries no delete branch that a live path could never reach.

**The row states the action its chevron performs.** A diff row renders a `查看变更` / `View change` button that becomes `收起变更` / `Hide change` while open. It sits in real flow after the `+n -n` totals and never shrinks, so a narrow row clips the path first and the control stays reachable.

**Parentheses are decoration, kept in CSS.** `.operation::before` and `::after` carry the `(` and `)`, so the dictionaries hold `修改` / `Modified` alone. A screen reader reads "path 修改" either way, and a locale that omits the wrapper can drop it without a code change.

**A reasoning block opens while it streams.** `ReasoningRow` seeds `expanded` from `running`, so a streaming thought shows its own text; the summary line — and its follow-the-tail scroll — still serves the reader who folds the block to read one line. The body caps at ten lines of the secondary tier (`max-height: calc((20px + var(--dsh-content-font-delta-secondary, 0px)) * 10 + 8px)`) and scrolls inside itself, because a chat flow reads many blocks at once and an unbounded thought would bury the reply.

**Settling folds the block once, on the transition.** An effect compares the previous `running` against the current one and collapses only on `true -> false`. A block that mounts settled — every replayed history message — stays closed, and a finished thought the reader reopened is never snatched shut by a later render. While streaming, the body follows the tail but releases that follow once the reader scrolls away from the bottom, so re-reading is never yanked back down mid-sentence.

**A Bash row shows its output at every stage, and the stage is what changes.** The terminal card is no longer gated behind `open`: the closed row renders it with output capped at two lines (`peek`), opening grows it to ten (`full`), and a control on the row reaches past the cap (`all`). The row carries its stage as `data-stage` on a wrapper, and both caps derive from `--dsl-terminal-line-height` (`calc(var(--dsl-terminal-line-height) * 2)` and `* 10`) rather than repeating a pixel height that would drift from the font binding. `maxLines` stays `Infinity` throughout: the primitive's own `maxLines` collapses the *middle* of a long output, which is a different gesture from the scroll the row wants.

The control appears only when the output is taller than the ten-line cap — a command that printed two lines has nothing past it to reach — and asking for the rest from a closed row opens it to ten lines first, so the reader is never dropped straight into an unbounded card. From ten lines it goes unbounded, and from there it puts the cap back rather than leaving the row stuck open.

**The closed preview hides its scrollbars.** A two-line thumb is too short to drag and would crowd the lines it sits beside; the open stages keep theirs, which is where scrolling is meant to happen. The scroll the row promises therefore belongs to `full` and `all`, matching the request that the cap be *scrolled* rather than truncated.

**Only the streaming block of a turn opens.** `AssistantMarkdown` passes `running={streaming && i === last}`, so a turn carrying several reasoning blocks opens the last one alone and leaves the earlier ones closed; each block owns its own state, so settling folds one without disturbing the others. Reopening re-takes the tail follow, so a thought that is still arriving shows its newest line rather than wherever an earlier scroll-up left off.

**Trajectory is untouched.** The `id: 'trajectory'` view registered by `packages/client/ui-trajectory/src/client/index.ts` assembles its own records through `TrajectoryCell` and reuses none of `ToolRow`, `FileMutationRow`, `BashRow`, or `ReasoningRow`, so no code in this change reaches it.

## Alternatives considered

**Derive the operation from the call arguments instead of the presented hunks.** Rejected: `write` carries no previous revision in its arguments, so a create and an overwrite are indistinguishable at that layer. The Host presenter's metadata is the only place the distinction exists, and it is already what the row presents.

**Put the parentheses in the dictionaries (`'(修改)'`).** Rejected: it makes a wrapper a translation obligation, so a locale that does not use it cannot drop it, and every new operation key has to remember the convention. CSS owns decoration; the dictionary owns words.

**Keep the reasoning block collapsed by default and only widen the summary.** Rejected: a streaming summary is one line of a thought that may be hundreds of lines long. The request was to watch the reasoning, which needs the body.

**Fold the reasoning block on every render where `running` is false.** Rejected: it would slam shut a finished thought the instant the reader opened it. Folding on the transition only, tracked in a ref, costs four lines and keeps the control with the reader.

**Two Bash stages instead of three (two lines, then unbounded).** Rejected: it loses the ten-line cap, which is the property that keeps a long command from owning the viewport. The third stage exists precisely so the reader can opt out of the cap deliberately.

**Cap the terminal with `maxLines` rather than a CSS height.** Rejected: `maxLines` drives `headTailCap`, which drops the *middle* of the output and shows a `… N more lines` toggle — a truncation, not the scroll this row needs. The primitive already exposes `--dsl-terminal-output-max-height` with `overflow-y: auto` on `.output`, which is exactly the scroll semantics requested.

**Render the terminal only when open (the previous behavior), changing just the cap.** Rejected: it leaves the closed row unable to answer "what did it print", which is the question a command row is most often asked. Showing two lines costs nothing the reader has to open.

**Apply the same treatment to the Trajectory view for visual parity.** Rejected as scope, not as a goal: the two views share no row components, so parity would mean building the same three features a second time against a different record model. Revisit if the views ever share a row primitive.

## Consequences

Two existing tests encoded the old Bash contract — that the terminal card is absent until the row is opened — and were updated to assert the stage attribute instead, since the card is now present at every stage and only its height changes. The same is true of the `assembly-surfaces` coverage of the keyed row reaching its terminal card.

A streaming reasoning block that is never folded now shows its body instead of its tail line, so the follow-the-tail summary scroll is reachable only after folding. That trade is the point of the change; the folded path keeps the behavior, and `reasoning-row.client.spec.tsx` pins both.

The ten-line caps are CSS text, which jsdom cannot lay out, so `chat-font-axis-styles.client.spec.ts` and `tool-row-styles.client.spec.ts` assert the declarations — including that each cap derives from `--dsl-terminal-line-height` rather than restating a pixel height. The stage machine itself is pinned in `terminal-card.client.spec.tsx`, which walks `peek -> full -> all` and back.

Showing the terminal on the closed row costs DOM that it previously did not: every output line is mounted at every stage, where a closed row used to render one summary line. The cap is visual — `overflow` hides the excess without removing it from the tree — so the cost is bounded by the largest output in the session rather than by what the reader has opened. That is accepted because showing two lines by default was the explicit request; if very long outputs prove expensive, the fix is to render a head slice at `peek`, which needs support in the primitive rather than in this row.

`FileOperation` ships with `deleted`, which no shipped tool can produce. It is one reserved member and one dictionary pair, recorded here as unreachable so no reader mistakes it for a supported state — and so the next reader knows where a delete tool would have to land.
