# Agent Note: One add-model dialog, and a picker that starts from what the provider already has

Status: implemented

English | [中文](2026-09-02-models-add-dialog-and-picker-defaults.zh.md)

## Problem

The Models settings page offered two buttons for one intent. **添加提供方** (Add provider) picked a route out of the adapter's installed catalog; **添加自定义提供方** (Add a custom provider) declared a route the catalog does not ship. Both exist to gain a provider, and they differ only in where the route's vocabulary comes from — yet the operator had to classify their own situation before choosing, and a user with a company gateway had to recognize that the *second* button was theirs. Each button expanded an inline card below the rows, so the page grew under the operator while they scrolled, and the two cards duplicated the same footer, the same close semantics, and the same provider-card extension dispatch.

The **获取可用模型** (Fetch available models) picker had a second, quieter defect: it opened with every discovered model checked, in the create case and in the edit case alike. On a provider that already configures three of forty discovered models, adopting the picker meant unchecking thirty-seven rows or accepting a write that re-adds all forty — an affordance that reads as "add the models I tick" silently became "keep everything".

## Decision

**One 添加模型 / Add model button opens one dialog carrying both ways in.** The chooser shows the provider `<select>` over the dormant directory rows — not yet configured, with a settings address — plus an **或手动输入 API 地址** field and its 继续 button beneath it. Picking a route expands the ordinary provider editor card for that route inside the dialog, the same editor a saved row's dialog opens; typing an address expands the hand-declared create card seeded with that trimmed address as its base URL, so the endpoint is never asked for twice. 返回 (Back) returns from either card to the chooser, and the chooser states that every provider in the adapter directory is already configured when no addable row is left. The button is disabled when the directory has nothing left to add and no protocol is available to declare a route by hand.

**A card already open resolves its row from every joined row, not from the addable set.** A refresh that configures the route mid-draft — the credential-retry path, or a second operator — would otherwise tear the card out of the dialog while the user is typing into it.

**The dialog keeps dispatching `settings.models.provider-card` for a picked route.** The seat is keyed by the row's settings namespace, so one registration under an adapter family's namespace receives the add card exactly as it receives a saved row's card; the add draft is the moment the operator has the provider in hand and no key yet, which is where that seat earns its keep. The hand-declared card still dispatches nothing until it is saved, because it has no directory row to key on.

**The picker's default selection follows the scenario.** When a provider row is being edited, the picker opens with the models that provider already configures checked, so adopting it keeps what is stored and adds what is ticked. When the provider carries no models yet — the add case — it opens with every discovered model checked, so adding a provider still takes one action instead of forty. The filter still narrows the rows shown and never the selection, and nothing is written until 添加所选.

## Alternatives considered

**Keep the two buttons and just relabel them.** Rejected: the label was never the problem. Two entries force the operator to answer a question the page can answer itself once both paths sit behind one button — whether the route they want is in the installed catalog.

**Merge into one inline card with an internal mode toggle.** Rejected: it keeps the page-growing card, and the mode toggle is a second question on a surface that already asks for an endpoint, a protocol, and a model. A dialog over the section states that adding a provider is one bounded step and gives the two paths equal prominence; a card below the rows competes with the rows it is about to create.

**Ask the way in first, then show only the chosen card.** Rejected: the operator who types an address and then wants a catalog route instead has to leave and re-enter. The chooser stays reachable through 返回, so a wrong first guess costs one click rather than a restart.

**Open the picker with nothing checked (in both cases).** Rejected: it makes the common add case — take what this endpoint offers — forty clicks, and 获取可用模型 exists precisely to answer "what does this endpoint have?" in one pass.

**Open the picker with everything checked (the previous behavior).** Rejected: it is correct for a provider with no models and wrong for one that has them. Defaulting to the provider's own configured set is the only default that means "add what I tick" in both cases.

**Make the picker write the whole model list as a replace.** Rejected: it changes a settings write into a destructive one behind an affordance labelled 添加所选, and a provider whose catalog lost a model would silently lose the row. The picker still only adds; removing a row stays the row's own delete action.

## Consequences

The section lost one button and gained a dialog, so the add flow no longer competes for vertical space with the rows; the cost is a second modal nesting level under the settings dialog, which the primitives' `Modal` already supports through its portal.

**添加模型** now names the section entry, so the model catalog's own row button was renamed to 手动添加 / Add manually — the gesture it performs, next to the 获取可用模型 button that fills rows from the endpoint instead. The hand-declared card's seeded base URL is editable, because the address the operator typed to get in is the address they most likely want, not a value the page owns.

The picker's edit-case default is a behavior change a returning user can feel: 获取可用模型 on a configured provider now pre-checks fewer rows than before. That is the point — the pre-checked set is the set already stored — and clearing it still takes one 取消全选.

**编辑** later took the same treatment: a saved row's card opens as its own dialog over the section, at the same width as this one, and the first-run card that used to expand inside a row opens as that dialog too — see [one provider card, one dialog, one width](2026-09-03-models-edit-dialog-and-card-width.md).
