# Agent Note: One provider card, one dialog, one width

Status: implemented

English | [中文](2026-09-03-models-edit-dialog-and-card-width.zh.md)

## Problem

The Models settings page had two card homes for the same editor. 添加模型 opened a dialog over the section — a decision [one add-model dialog](2026-09-02-models-add-dialog-and-picker-defaults.md) took deliberately, so adding a provider stops competing for vertical space with the rows — while 编辑 expanded the identical `ProviderEditor` *inside* the row it was editing. The page therefore still grew under the operator, but only on the edit path, and the card's layout depended on which door the user came through: the same model row laid out side by side in the dialog wrapped in the row.

The dialog's width rule never took effect. `ModelsSection.module.css` gave `.addDialog` a `max-width: 560px`, but `Modal`'s own dialog rule is `width: min(380px, 100%)` and its `overflow: hidden` zeroes the flex item's automatic minimum size, so the definite 380px width won: both provider cards rendered at the primitive's default width however wide their rule asked for. Nothing detects this — the class attaches, the sheet loads, and the only symptom is a card that reads as too narrow.

## Decision

**编辑 opens the card as a dialog.** `EditProviderDialog` renders the same `ProviderEditor` in the same `Modal`, titled with the same `editProvider` copy the Edit button carries as its accessible name, so a screen reader announcing the button finds the card it opened by that name. The row stays a row: the list is a list of rows, and the card is never the row's expanded state.

**Both provider dialogs share one width rule, declared as `width: min(570px, 100%)`.** `width`, not `max-width`, because only `width` overrides the primitive's definite width; 570px is the width the user actually saw (380px) plus the 50% they asked for. `.addDialog, .editDialog` and `.addDialogContent, .editDialogContent` are written as one pair of rules rather than two, so the two cards cannot drift apart. `styles.client.spec.ts` pins the declaration: the rule must set `width`, must not fall back to `max-width`, and both dialogs must agree.

**The `settings.models.provider-card` seat follows the card.** A row whose dialog is open dispatches the seat inside that dialog and not on the row, so the extension area renders once per card wherever the card is. Dispatching it in both places would put a registrant's UI on screen twice for one provider.

**The first-run posture opens the same dialog, by itself.** A whole-section provider whose key is configured nowhere and which no other row makes unnecessary still surfaces its card without a click — it is now the same dialog rather than a third kind of card — and dismissal (取消, the chrome's close, or Escape) is the card's own: the provider falls back to an ordinary row for the rest of the session, and reopens through 编辑. One card is open at a time, so reaching for 添加模型 closes the card the posture opened.

**A row a refresh dropped closes its card.** The dialog resolves its row from the joined rows on every render; a pushed invalidation or a reload that removes the route leaves no card editing a path the directory no longer lists.

## Alternatives considered

**Widen the add dialog and leave 编辑 inline.** Rejected: it keeps two layouts for one editor and keeps the page growing on the edit path, which is the growth the add dialog was created to remove. It also leaves the row's height a function of what the user last clicked.

**Bump `max-width` to a larger number.** Rejected: it changes nothing. The primitive declares `width`, so a larger `max-width` stays inert and the card stays 380px — the fix has to be a `width`, and the stylesheet test now says so.

**Base the new width on the declared 560px (→ 840px).** Rejected by the request: the basis the user named is the width on screen. 570px is that width plus 50%; 840px would be 2.2× what the user sees.

**Drop the first-run card and let the row prompt for itself.** Rejected: it removes the one prompt this page gives a user who cannot reach any provider, and the onboarding takeover covers only the official DeepSeek route. Modalizing the card keeps the prompt and removes the third card kind.

**Reuse `AddModelDialog` with an edit stage.** Rejected: the add dialog is a chooser in front of two cards with its own back-and-forth; the edit card has no choice to offer. A stage would add a branch to a state machine that exists only to hold the chooser.

**Title the dialog with the provider's display name.** Rejected: the dialog's accessible name should be the action that opened it, exactly as 添加模型 names the add dialog after its button. `editProvider` copy already carries both the display name and the route id, so no fact is lost by hiding the editor's own title inside the dialog.

**Keep dispatching the card seat on the row as well.** Rejected: two occurrences of one keyed seat for one row renders a registrant twice on the same screen. The seat is per card, and the card is in the dialog.

## Consequences

The edit path now nests a second modal under the settings dialog, as the add path already did; the cost is that the rows behind it are unreachable until the card closes, which includes 添加模型 while the first-run card is open. Dismissing that card is one click, and its dismissal is remembered for the session.

The provider-card seat moved surfaces, so a registrant under an adapter family's namespace now receives the card from the dialog rather than from the row while the row's card is open; the dispatch key, owner props, and one-occurrence-per-card guarantee are unchanged.

Two e2e goldens now pin the editor as a dialog — `models-settings/declared-edit.expected.md` and `onboarding-deepseek-config/models.expected.md` — each named by the dialog's accessible label rather than by whichever dialog the page happens to render first, because a portaled dialog is a sibling of the settings dialog and not a descendant of it.
