# Agent Note: Tool output and thinking read the Settings font size, not the secondary tier

Status: implemented

English | [中文](2026-09-03-tool-output-and-thinking-read-body-font-size.zh.md)

## Problem

Settings → General → Font size names one number and every reader takes it to mean "the conversation". Two surfaces ignored it.

**Tool output was pinned at 11px.** The IN/OUT card, the terminal card, the code body, and the diff/read/search bodies all read `--dsw-font-markdown-code-block-small` (11px/16px) or `--dsw-font-markdown-code-block` (11px/19px) — Figma ladder tokens with no axis in them. Raising the setting to 17px grew the narration and left the tool output it produced at 11px, so a user who enlarged the text for legibility got no benefit on the exact content that is hardest to read: command output, diffs, and source excerpts.

**The tool row and the thinking row read one step under the body.** Every text on those rows — title, summary, path, diff totals, the collapsed thought — read `--dsh-content-font-size-secondary` (setting −1 at ≤14, setting −2 above) and the thought body set its own 20px leading on the secondary delta. The tier exists for the flow's meta furniture (message clocks, stat pills, command summaries) and is right there, but on these two rows it separated a row's title from the summary beside it and left the thought smaller than the reply under it.

Both were deliberate tier decisions, and both read as the setting being broken.

## Decision

**One new token carries the body measure into the code family.** [`gradient-shadow-text.css`](../../../../packages/client/ui-theme/src/styles/gradient-shadow-text.css) adds `--dsh-content-font-code`: the body font size and the body line height (`calc(24px + var(--dsh-content-font-delta))`) in `--ds-font-family-code`. It changes the family only, never the measure, so an adoption site cannot accidentally reintroduce a smaller size while still reading the axis.

**The primitives that only draw tool cards now default to that token.** [`TerminalBlock`](../../../../packages/client/ui-primitives/src/TerminalBlock.module.css), [`DiffBlock`](../../../../packages/client/ui-primitives/src/DiffBlock.module.css), [`ReadBlock`](../../../../packages/client/ui-primitives/src/ReadBlock.module.css), and [`SearchBlock`](../../../../packages/client/ui-primitives/src/SearchBlock.module.css) set their body font and their line-height variable from it; [`WebBlock`](../../../../packages/client/ui-primitives/src/WebBlock.module.css) binds its result title, snippet, and fetch URL to the body size, since those read as prose rather than as code. All four are reached only from `ui-tool` today, so their default is the tool-card presentation and no consumer needs a rebinding. The consumers that did rebind smaller — [`ToolRow.module.css`](../../../../packages/client/ui-tool/src/client/tool/components/ToolRow.module.css) `.codeBody`/`.terminalBody` and [`bash-sample.module.css`](../../../../packages/client/ui-tool/src/client/tool/toolviews/bash-sample.module.css) `.terminal` — drop those rebindings; `CodeBlock` keeps its own smaller default because markdown fences share it.

**The two rows rebind the shared header's title instead of dropping the tier.** [`DisclosureRow`](../../../../packages/client/ui-primitives/src/DisclosureRow.module.css) gains `--dsl-disclosure-title-font-size`, defaulting to the secondary tier, and reads it in `.title`. `ToolRow` and [`ReasoningRow`](../../../../packages/client/ui-chat/src/client/chat/ReasoningRow.module.css) rebind it on their own roots to `--dsh-content-font-size`. The tier stays where it belongs — command cards, context injection, system prompt, and the workflow panel keep the meta size — while a row whose whole body reads at the body size lifts its title with it.

**Everything else on those two rows moves to the body size too.** `ToolRow`'s summary, summary suffix, file link, operation qualifier, and change toggle read `--dsh-content-font-size`; the diff-row `+/-` totals stay two px under it, because mono digits read optically larger than the sans path beside them at the same size. `ReasoningRow`'s summary and `thinkBody` read the body size and the body leading, and the thought's ten-line cap rides `calc((24px + var(--dsh-content-font-delta)) * 10 + 8px)`.

**The read gutter stops being a fixed 48px.** [`ReadBlock`](../../../../packages/client/ui-primitives/src/ReadBlock.module.css) sizes it `max(48px, calc(4ch + 14px))`. `ch` resolves against the rows' own font, so the column keeps holding four digits at 17px where a fixed 48px would have overflowed into the content; the 48px floor is the Figma width, which the smaller settings keep rather than narrow.

## Alternatives considered

**Redefine `--dsh-content-font-size-secondary` to equal the body size.** Rejected: the tier is correct for the meta furniture that shares it, and collapsing it would enlarge message clocks, stat pills, command summaries, and markdown tables to make one variable do two jobs.

**Change `DisclosureRow`'s `.title` to the body size for every consumer.** Rejected: that is the tier's remaining home. A command card and a context-injection row are meta rows; making their titles the body size would only move the complaint to the rows nobody named.

**Rebind the primitive fonts from `ToolRow` instead of changing their defaults.** Rejected for the four tool-only primitives: a rebinding is a second place to keep in sync, and every consumer of those four is a tool card. Kept for `CodeBlock`, which markdown fences also render.

**Keep the code line heights tight (20px + delta) while matching the size.** Rejected: the user asked for the line height to match the body's as well, and a tighter leading would have made the enlarged output read as a separate, denser register rather than as the same text.

**Leave the cards' banner chrome (copy button, path label, language tag) at its own size.** Kept: those are card furniture, not output. They read next to a control, not as prose, and they are where the tier's dim tone already does the work.

## Consequences

One setting now governs the whole conversation: raising the font size raises narration, tool output, command output, diffs, source excerpts, search results, web results, and thinking together. The cost is density — a terminal card that showed ten lines of 11px output in 224px now shows about nine lines at 14px, and a ten-line thought is taller because its leading is the body's. Both are the intended trade: the user asked for one size, not for more lines.

`--dsh-content-font-code` is now the seam to move for any future code-family surface that should follow the setting, and `--dsl-disclosure-title-font-size` the seam for any future row whose body reads at the body size.

## Testing

- `tool-row-styles.client.spec.ts` — the summary, suffix, and file link read `--dsh-content-font-size`; `.root` rebinds `--dsl-disclosure-title-font-size`; the bash row's output caps still derive from `var(--dsl-terminal-line-height)` and no longer rebind the measure.
- `chat-font-axis-styles.client.spec.ts` — the thought summary and body read the body size and body leading, `.root` rebinds the title variable, and the ten-line cap rides the body leading.
- `disclosure-row-styles.client.spec.ts` — `.title` reads the rebindable variable and `.root` defaults it to the secondary tier.
- `apps/web/tests/settings-chrome.e2e.ts` — the font-size stepper case probes `--dsh-content-font-code` in the real engine, where `min`/`max`/`calc` actually evaluate: 14px at the default and 16px after two steps up. A CSS-text assertion can only pin the declaration; this pins that the measure every tool card reads is the setting rather than a ladder size.
- `packages/client` suite: 3972 passed, 1 failed. The failure is `ui-theme/tests/scrollbar-styles.client.spec.ts` on `UserTurnPanel.module.css`, which this change does not touch; it is a pre-existing failure on this branch, already recorded in [2026-09-03-chat-ux-resize-menu-file-rows.md](2026-09-03-chat-ux-resize-menu-file-rows.md).

## Deferred

The remaining secondary-tier surfaces — command cards, context injection, the system-prompt row, stat pills, message clocks, and the workflow panel — keep the meta size. They were not named in the complaint and they are furniture rather than content; unifying them is a separate decision about whether the meta tier should exist at all.
