# Chat UX Polish Design — Six Pane-Level Optimizations

English | [中文](chat-ux-polish.zh.md)

> Status: draft, awaiting user confirmation before implementation
> Audience: maintainers and decision makers
> Related request: six pane-level UX polish items in the chat surface, all client-only, all reversible individually, none altering agent-loop or session protocol.

---

## 1. Background and motivation

The chat surface has accumulated small fragilities from successive Figma-first polish passes. Together they make the surface feel rough despite the protocol and engine being in good shape. This design collects six user-visible items into one change so the shared plumbing stays coherent — a hero composer state, a model picker pane, a language directive, a session-changes surface, a transient error channel, and a tool-card style lift.

| # | Item | File |
|---|---|---|
| 1 | New-session composer has no resize handle | `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`, `InputBar.module.css` |
| 2 | Model picker opens a two-level menu when one would do | `packages/client/ui-model-selection/src/client/ModelSelect.tsx` |
| 3 | LLM still answers in English even when GUI says `中文` | `packages/context/response-language/src/index.ts`, `packages/client/ui-settings-general/...` |
| 4 | No session changes list, no per-file keep/reject | new package `packages/client/ui-session-changes` |
| 5 | Errors that were already auto-recovered stay on screen | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`, facade notices |
| 6 | Edit / write tool rows read like any other tool row | `packages/client/ui-tool/src/client/tool/components/ToolRow.module.css` |

Each is independent at the protocol level — every entry only touches client-only seam code (Slot / CSS / SystemPrompt section / extracted new package) and the result is reversible by removing the composing plugin or rolling back the CSS.

---

## 2. Goals

- Lift day-to-day chat UX across six visible rough spots in one shipped change.
- Match the Codebuddy reference for the changes surface (per-file accept / reject, checkpoint grouping) without rewriting Cordis or the agent-loop.
- Keep every item behind existing extension points: chat/composer seat, model slot, system-prompt registry, a new composable Slot, the conversation.composer.dock footer, and tool-row CSS.

## 3. Non-goals

- No new wire protocol, no agent-loop change, no new tool schema, no new LLM capability.
- No new dependency for "view changes" — the user explicitly excluded it for this change.
- No change to the `tool/result` event shape; the existing `isError` / content fields stay canonical.
- No Chinese prompt rewrite beyond the targeted response-language directive tweak.

---

## 4. Current state

### 4.1 Reusable existing surfaces

| Surface | Location | Reused by |
|---|---|---|
| Composer height handle (drag + keyboard + reset) | `ConversationRoot.tsx` `HeightHandle` | Item 1: same drag plumbing, new mount point |
| ModelSlot two-pane dropdown | `ui-model-selection/ModelSelect.tsx` `Pane` state machine | Item 2: drop the root pane on click |
| `response-language` system-prompt section | `packages/context/response-language/src/index.ts` `RESPONSE_LANGUAGE_SECTION` | Item 3: stronger directive + verify the read path |
| `ProducedFiles` (turn-tail slot, one-line chip row) | `packages/client/ui-deliverables/` | Item 4: extend the same source-of-truth accumulated `producedForClosing` per turn into a checkpointed accept/reject list |
| `conversation.input.dock` slot above composer seat | `ConversationRoot.tsx` composer bar | Item 4: new dock surface `conversation.session.changes` |
| `InputNotice` snapshot store (`SessionInputShell.notices`) | `ui-conversation/.../facade.ts` | Item 5: clear stale errors when the orchestrator hits a steady state |
| `data-variant` on tool rows + diff card | `ui-tool/.../ToolRow.module.css` | Item 6: add `data-variant=edit/write` accent rules |

### 4.2 Architectural constraints (they shape the work)

1. **Slot composition, not loop changes.** Every piece of new chrome lives behind a Slot the way `ProducedFiles` already does — the orchestrator and engine are not touched.
2. **Locale-owned copy.** Every new translation passes through `t('key')` and the dictionary in the package's `locales.ts`, with both `zh` and `en` checked complete against the same key set.
3. **Pre-release stance: foundation over blast radius.** Removing a composing Slot must restore the prior behavior; rolling back a CSS rule must restore the prior look. This constrains the design of item 4: the changes surface is its own package, not a fork of `ui-deliverables`.
4. **Direct file rollback is not yet a first-class operation.** `tool-fs` write/edit do not capture a per-call previous-content snapshot at the storage boundary. Item 4's reject path therefore needs a deliberately bounded strategy (item 5.4 below), not a free-form undo engine.
5. **TypeScript narrow types.** No `any`, no `@ts-ignore`. The five-line contract additions (e.g. the new Slot, the rejected-paths projection) get JSDoc and `readonly` arrays.

### 4.3 Findings from inspecting code

- `ConversationRoot.tsx:521` mounts `<HeightHandle>` only when `phase === 'active'`. New sessions with no committed first turn are `phase = 'hero'`. The Handle is missing and `InputBar.module.css:135-137` explicitly forces `.hero .scroll { height: auto }`. Two changes undone together.
- `ModelSelect.tsx:29, 119-122, 248-263`: `Pane = 'root' | 'model' | 'effort'`. `show()` always opens the root pane. With a model chosen, effort may be undefined → the effort cell hides (line 255) → the root pane ends up with a single "模型" cell that drills. Removing the root pane for the click path is a one-line state change plus a redirection of the trigger's keyboard semantics.
- `response-language/src/index.ts:41-43`: only `zh` ships a directive. The directive text reads "Reply to the user in Simplified Chinese (简体中文). Write every sentence a person reads in Chinese …". Several users report LLM still writes English in mode `auto`. Two real candidates: (a) the locale preference is never reaching `locale.preference` (settings write-path bug) or (b) the directive is too soft and the model falls back to its prior. We do both — strengthen the directive and instrument the read.
- `ui-deliverables/turn-deliverables.ts:122-135`: `producedForClosing(data, seq)` is already a stable per-turn mutation list (de-dup, first-seen order). Item 4 raises its visibility into a session-wide surface that lives across turns, but **does not duplicate** the source-of-truth — it subscribes to the same `turn-deliverables` definition.
- `facade.ts:557-560`, `InputBar.tsx:97-106`: `notify(level, text)` writes `this.notices.set({ level, text, seq: ++this.noticeSeq })`. Errors stick at the head of the sequence until the next `notify` of any level. Item 5 adds a dedicated `clearNotices()` verb driven from session readiness.
- `ToolRow.module.css`: `data-variant` only has `code` and is the only variant that materializes inside `[data-tool^='cordis_']` accent rules. `data-tool` with `edit/write` already routes through the diff card but the surrounding row reads identical to read/search/bash. Item 6 adds accent rules keyed off `data-tool=write` and `data-tool=edit`, plus a small badge for `(写入)` / `(修改)` inside the operation slot.

---

## 5. Options considered (per item)

Each item gets ≥ 2 candidates, a recommended one and the implementation outline, a fallback when relevant. The "Reasons against" covers the typical concerns.

### 5.1 Item 1 — New-session composer needs a resize handle

**A. Extend `phase` to expose a `hero-resizable` value, render `<HeightHandle>` there too.** *(recommended)*
Render Handle on `hero` and `active`. Drop `.hero .scroll { height: auto }`. Adapt the CSS so the hero composer's card height is bounded by the same `--dsh-composer-user-height` variable.

- Pros: same drag/keyboard/reset UX, same persisted key (`localStorage` `dsh.conversation.composerHeight`), same `resolveComposerHeight` clamp. ~30 lines of TSX/CSS.
- Cons: the hero composer is centered and sized to content; a dragged height on hero makes a long hero card visually heavier than the figma intended. We address that with a soft floor (`COMPOSER_MIN`) that the existing clamp already enforces.

**B. Promote the handle to a sibling state machine with three phases (`'hero' | 'hero-resizable' | 'active'`).**
Reasons against: an extra phase is only justified if the hero path needs materially different handle styling, which it does not.

**C. Disable resize on hero, document it as a known difference.**
Reasons against: the user explicitly asked for parity.

### 5.2 Item 2 — Clicking the model trigger jumps straight to the list

**A. Drop the `root` pane on the `model` choice trigger, keep it for the `effort` choice.** *(recommended)*
Trigger click → `setPane('model')`. Effort then drills in from inside the model list via a small secondary affordance. This converts the two-level menu into one mandatory pane (model) plus an optional effort drill.

- Pros: removes the user's unnecessary tap; preserves "推理等级" as a separate control when present.
- Cons: a model whose `reasoning.efforts.length === 0` and `defaultEffort` undefined no longer needs the root pane at all — same behavior as before.

**B. Keep root pane, remove effort cell when reasoning is undefined, but render the model list directly inside root when reasoning is undefined.**
Reasons against: users with reasoning land in the same root pane; users without land in the list directly. Two paths converge on the user's perception is fine, but a single trigger behavior is simpler and matches the user's request.

**C. Open a separate trigger for effort.**
Reasons against: doubles the UI surface for a value many models do not expose.

### 5.3 Item 3 — Force Chinese output when GUI says `中文`

**A. Strengthen directive + audit the read path.** *(recommended)*
Strengthen the `zh` directive with an explicit "no-English-fallback" clause and audit `localePreference` against the Web GUI's stored value. The audit surfaces the existing or absent bug to us; the strengthened directive tightens the model regardless.

The new directive reads:

```
Reply to the user in Simplified Chinese (简体中文). Write every sentence a person reads
in Chinese — explanations, plans, progress updates, summaries, questions, and the
prose of commit messages, reports, and documents you author. Do NOT switch to English
when reproducing identifiers, paths, commands, or quoted user/tool output; quoted text
stays quoted, surrounding prose stays Chinese. If the user writes in English, mirror
their tone but keep your reply in Chinese unless they explicitly ask otherwise.
```

The audit instruments the read by logging (gated by `dsh.dev.trace`) the resolved `preference` / `environment` / final language, so the next reproduction returns which leg of the chain failed.

- Pros: minimal blast radius, no model contract change, no new config surface. The trace log is opt-in and dies with the session.
- Cons: a force-`off` Chinese behavior on a sandbox without an `auto` directive cannot be added in one PR (that needs an `en` directive, which the project will consider separately).

**B. Add an `en` directive as a positive control.**
Reasons against: out of scope; out of scope is the team's choice to add `en` directives only as needed and its absence today is intentional.

**C. Change the prompt via context.**
Reasons against: contexts are drop-on-suppression; the directive belongs at section order —950 where the harness identity and language stand together.

### 5.4 Item 4 — Session changes surface with per-file keep / reject

**A. New package `packages/client/ui-session-changes` with a `conversation.session.changes` Slot mounted in the dock above the composer seat.** *(recommended)*

The Slot listens to one new `ConversationNodeDefinition` that subscribes to the existing `tool/call` + `tool/result` events for `write` / `edit` / `str_replace_editor` writes. Reuses `mutationPath()` and the `turn-deliverables` vocabulary verbatim so the existing per-turn "产物" line keeps working.

**Confirmed decisions (from user feedback):**

1. **No checkpoint grouping.** The surface is one flat list of changed files, in first-write order. No "检查点 N" folders, no grouping chrome.
2. **Reject does NOT touch the file.** Phase 1 has no per-file rollback inventory under the FS tools (`write` overwrites; `git checkout -- path` would wipe other uncommitted work). The reject action writes a `撤销 <path>` item into the user's TODO list and the status copy says plainly "this is a reminder only — real revert is not done yet". The user chose this over silent `git checkout` and over a partial git-revert.

The card has two states:

- **Collapsed** — one line: `N 处变更 · 全部接受 / 全部撤销` summary, with the count.
- **Expanded** — a flat row per changed file. Each row names the file (basename + relative path, reuse the existing `basename`/`relativizeToCwd` helpers), the operation (`写入` / `修改`), and two actions: **接受** (remove the row from the list; the on-disk result stays as written) and **拒绝** (also remove the row, and write a `撤销 <path>` TODO entry). A header "全部接受 / 全部撤销" applies to every row at once.

Accept/reject only mutate the surface state and, for reject, the TODO list. The files on disk stay as the tool wrote them.

- Pros: Slot composition matches `ProducedFiles`. One new package keeps blast radius contained. Both `zh` and `en` dictionaries are co-located. No checkpoint state machine to maintain.
- Cons: no real file revert in v1 — which the user explicitly accepted.

**B. Build a baseline-snapshot store in `tool-fs`.**
Reasons against: requires FS storage to grow a snapshot sidecar keyed by `(tool-call-id)`, which is a deep change to a capability seam. The user requirement is a UX item, not a storage feature, and the user chose "先不做拒绝".

**C. Compose existing `ProducedFiles` into a richer dock and add the reject path inline.**
Reasons against: mixes the deliverable row (per turn, 1-line cap) with session-scoped state (across turns, expandable). Two packages keep one-row vs session-list concerns readable; forking `ui-deliverables` couples them.

### 5.5 Item 5 — Errors a retry already solved must not render

**A. Gate the `model-retry` node on the turn's terminal outcome: a retry that ultimately succeeded hides its failure detail, only a turn that still failed shows it.** *(recommended)*

**Confirmed scope (from user feedback):** a failure that a retry resolved must not reach the page at all; only a failure no retry resolved shows. There is no "clear later" pass — the decision is made at render time from the turn's final state.

The mechanism that matches "retry solved it" is `llm-retry`'s automatic provider-routed retry: a failed model request schedules `llm/retry`, the wait fires `llm/retry-started`, and the next request attempt either succeeds (the turn closes normally) or exhausts the policy (the turn closes with `turn/end` `reason.kind === 'error'`).

Today `retry.ts` `buildViewNode` materializes the `model-retry` node whenever `attempts.length > 0`, and `ModelRetryItem` renders the failure detail (`node.failure.message`) inside a `<details>` that stays in the transcript after the retry succeeds. That is the "报错" the user still sees after recovery.

The fix is render-time, in `retry.ts`:

- Read the owning turn's terminal reason from `location.turn.end?.data.reason.kind`.
- When the turn closed **without** `kind === 'error'`, the retry chain ultimately succeeded → `buildViewNode` returns `null` (the `model-retry` node never renders, so the recovered failure detail never reaches the page).
- When the turn closed **with** `kind === 'error'`, the retry chain did not resolve the failure → the `model-retry` node renders as today, and the sibling `turn-error` node already carries the terminal failure.

The in-flight feedback is unaffected: while the turn is open (`turn.end === undefined`), the node still renders its neutral "重试中 / 已开始" state so the user sees that a retry is happening — the failure detail is only hidden once the turn proves it recovered.

- Pros: single decision point, no schema/event change, the "source" is the turn's own terminal reason, and the recovered failure never enters the view tree.
- Cons: the node is a historical record once written, so "no retry ever failed" vs "retry failed but a later retry recovered" are both represented by `turn.end.reason.kind !== 'error'` — both hide the detail, which is the behavior the user asked for.

**B. Auto-dismiss the transient `error` toast on retry recovery.**
Reasons against: the toast (`InputBar` `promptError` / `notices`) is a separate channel from the retry chain; gating it requires a cross-channel signal and would hide genuine send failures. Out of the confirmed scope.

**C. Move promptError down to a session-snapshot field with TTL.**
Reasons against: changes the existing `promptError` semantics the session controller already owns. Avoid.

### 5.6 Item 6 — Edit / write tool rows read at a glance

**A. Add `data-variant=edit` and `data-variant=write` accent rules + an inline `(写入)` / `(修改)` badge that already exists in `data-tool=write|edit`.** *(recommended)*

`ToolRow` already passes `toolName` through `data-tool`; CSS adds:

- `data-variant=write` + `data-variant=edit`: a 2px left rail using `--dsw-alias-state-business-primary`.
- a distinct summary tone: the existing `.summary` keeps tertiary; the new accent border on the row plus the `(写入)` / `(修改)` qualifier in `.operation` is the visible cue.
- hover: row gets a faint `--dsw-alias-interactive-bg-hover-solid` so a long transcript still picks up the cursor.

- Pros: pure CSS, no JSX change, no new keys, no perf cost.
- Cons: nothing else; this is one of the cheapest items.

**B. Wrap the edit / write cards inside a tinted surface with an inline mini header.**
Reasons against: increasing the row height by 16px across a long transcript fights the existing figma 24px single-line baseline.

**C. Animate a one-shot sweep on first arrival.**
Reasons against: `data-state='running'` already sweeps; doubling it would be noise.

---

## 6. Implementation plan (one batch per file/lane)

| # | Lane | Touched files (estimated) | Risk | Verifies |
|---|---|---|---|---|
| 1 | composer hero resize | `ConversationRoot.tsx`, `ConversationRoot.module.css`, `InputBar.module.css`, locales (`input.resize*` already exist) | low — same handle, two new mount calls | unit (`skeleton.client.spec.tsx` resize paths), Playwright hero drag |
| 2 | model picker single pane | `ModelSelect.tsx`, locales (`model.pane.title` etc.) | low — state machine flips, no schema change | unit (`ModelSelect` render with `available=true/false`) |
| 3 | response language strengthen | `response-language/src/index.ts`, one optional dev-trace log | low — text + observability | snapshot: `openspec / tests/system-prompt.spec.ts` (with new directive text) |
| 4 | session changes surface | new `packages/client/ui-session-changes/{src,tests}/`, dock slot wiring in `ConversationRoot.tsx`, optional locale additions in `ui-deliverables` | medium — new package, new slot, new definition; decompose into 2 sub-batches (B1 vocab + accept + flat list, B2 expand + reject-as-todo) | unit + e2e (`chat-view.client.spec.tsx` with stub events) |
| 5 | retry-recovered errors stay off the page | `retry.ts` (`buildViewNode` terminal-reason gate) | low — one render-time decision | unit (`conversation-node-definitions.client.spec.ts` adds recovered vs terminal cases) |
| 6 | tool card accent | `ToolRow.module.css`, `ToolRow.tsx` (one class change for variant) | none — pure CSS | snapshot diff |

Each lane lands as a separate PR / commit, with a one-paragraph design delta at the top.

---

## 7. Test plan

| # | Unit | Integration | Snapshot |
|---|---|---|---|
| 1 | `skeleton.client.spec.tsx` resize: `hero` + drag → stored pref + restored on remount | `lifecycle-chrome.e2e.ts` (smoke-drag the hero handle, persisted key) | none |
| 2 | `ModelSelect` component test: trigger click in `available=true` → state lands at `model` pane | Playwright: open settings in zh / en, click trigger, single menu visible | snapshot for `modelSelect.menu` |
| 3 | `response-language.spec.ts`: directive text + preference read (`gui-set`, `en-host`, `zh-host`, `off`) | dev-trace sample; `system-prompt.spec.ts`: zh directive present, en absent | snapshot for `zh-system-prompt` |
| 4 | new test files: `dock-render`, `flat-list-order`, `accept-flow`, `reject-flow` | `delivery` / `apps/web/tests/onboarding.e2e.ts` extends a single flow with one edit → reject shows TODO item | snapshot for collapsed/expanded surfaces |
| 5 | `conversation-node-definitions.client.spec.ts`: retry + turn/end error → node renders; retry + turn/end completed → node returns null | `lifecycle-chrome.e2e.ts`: a recoverable error does not leave a retry row | snapshot for the recovered transcript |
| 6 | visual regression via `test:docs` / `test:snapshot` for two callouts | none | snapshot for `ToolRow` style rows |

E2E: `pnpm dsh --profile headless "..."` runs through the `apps/web/tests/onboarding-usable-provider.e2e.ts` and `models-settings.e2e.ts` paths that already exist. Add two new tests:

- `chat-ux-hero-resize.e2e.ts` — drag the hero handle, persisted in localStorage, restored.
- `chat-ux-changes-accept.e2e.ts` — drive a one-shot edit call, accept it; one-shot edit + reject shows the TODO insertion.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Item 4 reject-as-TODO can be lost when the user navigates away (TODO list is session-scoped). | First version: same `todo_write` tool that ships today; document the gap. Future: persist TODO items at the session snapshot rather than per call. |
| Item 3 directive strengthens may bump an existing snapshot that validates the previous `zh` text. | Run `pnpm test:snapshot`; reshoot only the affected `zh-system-prompt` snapshot, with the snapshot owning the same prose identity (snapshot file is keyed `production-build`, see `snapshots/AGENTS.md`). |
| Item 5 hides the `model-retry` node's failure detail even when the user wants to inspect what was retried. | The neutral "retrying / started" state still renders while the turn is open; only the *recovered* turn hides the detail. The `turn-error` node and the full trajectory view remain the authoritative failure surface when a retry did not resolve the failure. |
| Item 6 left-rail accent raises the row's visual height when adjacent rows differ. | Use `border-left` (2px) on the *content* (not the row's outer box); the CSS already reserves the leading pixel through the existing chevron column. |
| Item 1 hero composer with a dragged height makes a long hero card heavy. | The existing `resolveComposerHeight` clamps a dragged height against the column minus the header budget; same clamp on hero. |

---

## 9. Confirmed decisions

These were resolved with the user before implementation; the implementation follows them.

1. **Item 3 directive tone** — *to confirm at implementation time.* The directive demands Chinese and forbids English for normal prose while keeping identifiers / paths / code / quoted output verbatim. (Not yet explicitly answered; the strengthened text in §5.3 stands unless the user says otherwise.)
2. **Item 4 reject mechanism — confirmed: "先不做拒绝".** Reject writes a `撤销 <path>` TODO item and the status copy states plainly that this is a reminder only, no real revert. No `git checkout`, no file touch.
3. **Item 4 surface layout — confirmed: no checkpoints.** One flat list of changed files in first-write order; no "检查点 N" grouping.
4. **Item 5 — confirmed: gate at the source.** A failure a retry solved never renders; only a failure no retry solved shows. Implemented as the `model-retry` node's terminal-reason gate (§5.5). No "clear later" pass exists.
5. **Item 6 accent color** — *to confirm at implementation time.* Plan is `--dsw-alias-state-business-primary` for the `edit/write` left rail unless the user picks another color.
6. **Deployment cadence — confirmed: the original plan.** Items 1+2+6 in one PR; items 3 and 5 each their own PR; item 4 its own PR with sub-batches (B1 vocab + accept + flat list, B2 expand + reject-as-todo).

---

## 10. Deferred work

- Item 4 reject path becoming a real file rollback (requires adding a snapshot sidecar to `tool-fs` write/edit). Tracked separately.
- Item 4 "查看变更" inside the chat (the user excluded for this change; needs a viewer hookup outside the dock slot).
- Item 3 `en` directive as a positive control (the project intentionally ships only `zh` today).

---

## 11. Source-of-truth pointers

| Topic | Path |
|---|---|
| Composer seat + hero phase | `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx` |
| Composer height handle | `ConversationRoot.tsx` `HeightHandle` |
| Composer scroll/CSS | `InputBar.module.css` `.scroll` / `.hero .scroll` |
| Model picker | `packages/client/ui-model-selection/src/client/ModelSelect.tsx` |
| Response-language directive | `packages/context/response-language/src/index.ts` `DIRECTIVES.zh` |
| Locale preference write | `packages/client/locale/src/locales/settings.ts` |
| Turn-tail vocabulary (produced files) | `packages/client/ui-deliverables/src/client/turn-deliverables.ts` |
| Composer dock slot | `ConversationRoot.tsx` `renderSlot('conversation.composer.dock', zone)` |
| Conversation notice store | `packages/client/ui-conversation/src/client/input/facade.ts` `notices` |
| Tool row CSS / data-tool | `packages/client/ui-tool/src/client/tool/components/ToolRow.module.css` |
| Tool row markup | `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx` |
