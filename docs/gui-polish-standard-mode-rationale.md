# Standard-Mode UI Polish: Aligning the Chat View with CodeBuddy

English | [中文](gui-polish-standard-mode-rationale.zh.md)

> Status: awaiting user alignment
> Branch: `feat/gui-polish-session-delete-resize-model-filter`
> Scope: `packages/client/ui-tool/*` + `packages/client/ui-chat/src/client/chat/ReasoningRow*` + `packages/client/ui-conversation/src/client/locales.ts`

## 1. Original request (user input)

> In "standard mode" the formatting of output on screen is quite unpleasant. Having grown used to the CodeBuddy interface, the user wants the deepseek harness output to look like CodeBuddy's, for example:
> 1. An edited file is shown as: file name + operation type + ±line count; a "View changes" button on the right; expanding reveals the change content;
> 2. The deep-thinking process is shown while it thinks, then auto-collapses once thinking finishes; while thinking, the default shown height is around 10 lines with a draggable scrollbar;
> 3. A command run shows 2 lines by default, with a show button on the right to view all, but at most 10 lines high; beyond 10 lines it scrolls;
> 4. File operations state their operation type, such as added, edited, deleted;
> If the change affects other modes, their presentation is changed per the same sketches above.

## 2. Requirement breakdown (4 independent changes + 1 cross-mode impact surface)

| # | Change | Components | User expectation | Current implementation | Gap |
|---|---|---|---|---|---|
| R1 | File-change fold row | `ToolRow` + `FileMutationRow` + `diff-card-model.ts` | Append an operation label such as `(modify)` / `(add)` / `(delete)` after the title; an explicit "View changes" button plus chevron on the right; expanding shows the DiffBlock | Title is the variant name "edit"/"write" with no operation label; only a chevron on the right, no "View changes" text | Missing operation label + missing explicit button |
| R2 | Deep-thinking block | `ReasoningRow.tsx` + `ReasoningRow.module.css` | Expanded by default (about 10 lines high with a scrollbar); auto-collapse after thinking finishes | Collapsed by default; unbounded height once expanded; no auto-collapse mechanism | Missing default-expanded + missing 10-line cap + missing auto-collapse |
| R3 | Bash command block | `BashRow.tsx` + `bash-sample.module.css` + `ToolRow.tsx` (terminal branch) | Shows 2 lines by default; click to expand to at most 10 lines (scrolls beyond) | Fully collapsed; TerminalBlock `maxLines=Infinity` once expanded | Missing default 2 lines + missing 10-line cap |
| R4 | Operation-type enumeration | `tool-call-model.ts` + `diff-card-model.ts` + locale | Three operations: add (create), edit (modify), delete (delete) | Only write/edit mapped, no delete tool; no operation copy in locale | Missing delete-tool mapping + missing operation copy |
| X1 | Other modes | `ui-trajectory/*` | If affected, change per the same standard | Trajectory renders fully independently and **does not reuse** `ToolRow` / `FileMutationRow` / `BashRow` / `ReasoningRow` | Default **unaffected**; to be stated explicitly in the change record |

## 3. Candidate approaches

### Approach A: minimal intrusion (style layer only, every prop/data flow unchanged)
- R1: insert an operation label beside the diffStat area at the end of ToolRow; keep the chevron trigger and add a "View changes" text button to its left
- R2: change the `useState` initial value + add `max-height` CSS + add a `useEffect` that auto-calls `setExpanded(false)` when the running state turns false
- R3: add constants `CHAT_TERMINAL_PEEK_LINES=2` and `CHAT_TERMINAL_MAX_LINES=10`; split BashRow into "collapsed" and "expanded" states — collapsed uses TerminalBlock with `maxLines=2` and allows a chevron click to switch to `maxLines=10`, and a second click switches to Infinity
- R4: only add 3 locale keys and an `operation` field on ToolRowModel; introduce no new tool

**Pros**: small change surface, unit tests are easy to add; trajectory is unaffected.
**Cons**: the Bash three-state switch (2 → 10 → ∞) is a slightly complex interaction; without a registered "delete" tool the operation is always "modify/add", which needs the user's scenario confirmed.

### Approach B: full CodeBuddy alignment plus a delete tool (recommended)
- All of Approach A's changes
- R4 extension: add `delete` / `remove` tool mappings in `tool-call-model.ts`'s `TOOL_VARIANTS` (if the package system has no `delete` tool, keep the mapping interface but leave it unregistered)
- Trajectory's tool cell renders through TrajectoryCell, **visually consistent with the Chat view** (changed in lockstep, but keeping its own event projection)

**Pros**: fully aligned with CodeBuddy; delete scenarios reserved; consistent visual style.
**Cons**: the Trajectory sync roughly doubles the work; introducing a delete tool may exceed the current package boundary.

### Approach C: ultra-minimal (style only, no interaction change)
- R2 changes only CSS height limits
- R1/R3/R4 are copy and style only, no interaction change

**Pros**: fastest.
**Cons**: does not meet the user's stated interactions such as "auto-collapse once thinking finishes" and "2 lines by default"; rejected.

**Recommended: Approach A** — keeps the existing architecture, leaves trajectory alone, minimal change, and closes all four requirement points.

## 4. Key open boundaries (awaiting user decision)

1. **Is the delete tool added this time?**
   - (a) Only add the locale key and a reserved model field, without introducing a delete tool (recommended)
   - (b) Register a delete-tool mapping in `tool-call-model.ts` (but pointless if no `delete` tool exists under packages)
   - (c) Add a delete tool under `packages/tools/*` across packages (out of scope)

2. **Is the Trajectory view changed in lockstep?**
   - (a) Leave trajectory alone and state that explicitly in the docs (recommended, because it renders independently)
   - (b) Change TrajectoryCell in lockstep for a consistent visual style (+50% work)

3. **Bash three-state switch (default 2 → click 10 → click all) or two-state (default 2 → click all)?**
   - (a) Three-state (matches CodeBuddy's "at most 10 lines" semantics better; recommended)
   - (b) Two-state (simpler, but loses the 10-line cap)

4. **Explicit "View changes" button or chevron only?**
   - (a) Explicit "View changes" text button plus chevron (recommended, matches the CodeBuddy sketch)
   - (b) Chevron only, no text (lighter, but the user's original words explicitly mention "the show button on the right")

## 5. Recommended implementation plan (starts after user confirmation)

Executed serially per subtask, following the dev-workflow 9 stages:

| Batch | Content | DoD marker |
|---|---|---|
| B1 | locale adds operation + fold-row copy (zh/en) | Translation keys complete + unit test asserts existence |
| B2 | R1: ToolRow + FileMutationRow operation labels + "View changes" button | Unit test asserts "modify"/"add" render correctly |
| B3 | R2: ReasoningRow default-expanded + 10-line limit + running→false auto-collapse | `reasoning-row.client.spec.tsx` all green |
| B4 | R3: BashRow three states (2/10/Infinity) + visuals aligned with ToolRow | `bash-sample` / `terminal-card` unit tests all green |
| B5 | R4: `tool-call-model` operation field + delete-tool reservation | Unit test asserts the operation field type |
| B6 | Local regression: `pnpm -w run test:unit -- ui-tool ui-chat ui-conversation` | 0 regressions |
| B7 | `changes/NNNN-gui-polish-standard-mode.md` + README index | Missed-catch review section written |

## 6. Risks and rollback

- **Risk 1**: ReasoningRow default-expanded inflates the chat stream → control with `max-height` + `overflow-y:auto`; CSS switches on `data-state`.
- **Risk 2**: the Bash three-state state machine adds cognitive load → constrain the state with a union type + enumerate in unit tests.
- **Risk 3**: locale key names drift from the existing convention → keep the `row.*` / `tool.title.*` namespaces.
- **Rollback**: every batch is independently revertible (`git revert <commit>`) without affecting the others.
