# Agent Note: One lifecycle contract for tool-row disclosure

Status: implemented

English | [中文](2026-09-04-web-row-lifecycle-disclosure.zh.md)

## Problem

Tool rows were supposed to open while their call runs and fold away the moment it settles. Only one component implemented that: `ToolRow` in `packages/client/ui-tool` opened on `state === 'running'` and collapsed through a `useRef` + `useEffect` transition guard. `ReasoningRow` in `packages/client/ui-chat` carried a hand-copied duplicate. Every other row that presents a tool or command result owned a bare `useState(false)`, so it neither opened while running nor folded on settlement.

Two consequences were visible. A `bash` call renders through `BashRow` — the keyed `tool.call.toolview` entry that replaces `ToolRow` — so it never opened while the command ran, and once a reader expanded it (a row click, or the `查看全部` height control) it stayed open for the rest of the session. `cordis_define` renders through `CordisDefineRow`, which is expandable while running because its source tabs come from the call arguments, and it had the same gap. `skill` and command rows were exempt in fact: they carry no output until they settle, so there is no lifecycle to drive.

The inverse defect was worse because it was invisible. `AskQuestionRow` passes `restingExpanded` (then `defaultExpanded`) as `transcript !== null`, and the transcript appears only in the settled result. `ToolRow` read that flag once, in its `useState` initializer, while its settlement effect collapsed unconditionally — so a row the reader had just answered folded shut in the same commit that produced the answer. The only test that named the transition, `tool-row.client.spec.tsx`, called `cleanup()` and rendered a fresh settled component, so it asserted the mount default and never exercised running → settled.

The lifecycle contract alone did not close the report. A closed `bash` row still rendered its terminal card at the two-line `peek` stage, so "folded" left the output box on screen — pixel-for-pixel the view the reader reported as never folding. Every other tool row removes its output entirely when closed; `bash` was the only row that kept a preview, and it was also the only row the reporter could name. Settlement folding was real and unobservable.

## Decision

`useLifecycleExpansion` in `packages/client/ui-primitives/src/use-lifecycle-expansion.ts` owns the whole contract and every row that has one uses it. It takes `{ running, restingExpanded }`, opens while `running` is true, and on the running → settled transition falls back to the *current* `restingExpanded` rather than to `false`. Reading the resting value at effect time — not from a ref, and not only in the state initializer — is what lets an ask-user row stay open through the settlement that produced its transcript. A `useRef` guard keeps the effect on the transition alone, so re-opening a settled row still survives every later render.

`ToolRow` renames its `defaultExpanded` prop to `restingExpanded`, because the old name described a mount-time default it no longer is. `BashRow`, `CordisDefineRow`, and `ReasoningRow` adopt the hook; `ReasoningRow` keeps its follow-the-tail scroll by wrapping the hook's toggle. `SkillRow` and `GenericCommandCard` deliberately keep `useState(false)`: both derive `expandable` from their output, which is null until the call settles, so a lifecycle hook there would move state no reader can observe.

A closed `bash` row renders no terminal card at all. `OutputStage` drops `peek`, so an open row is `full` (ten lines) or `all` (unbounded), and the card mounts and unmounts with `open` exactly as `ToolRow`'s body does; the two-line cap and the scrollbar suppression it needed leave `bash-sample.module.css` with it. The `查看全部` control is unchanged and now the only way to reach any output from a long command: it still opens a closed row to the ten-line cap before it goes unbounded. The card's `inspect` button moves inside the open branch, matching every row that gates its controls behind the disclosure.

## Alternatives considered

**Give `ToolRow` an effect that re-opens when `defaultExpanded` flips to true.** Rejected: it makes two effects fight over one state — the collapse fires on the same commit — and it leaves the duplicate copies in `ReasoningRow` and `BashRow` to drift again.

**Let each row keep its own transition guard.** Rejected: `ToolRow` and `ReasoningRow` had already diverged in naming and comment surface, and the two rows the reader sees most (`bash`, `cordis_define`) had none at all; a third or fourth copy would widen the gap rather than close it.

**Collapse on every render that is not running.** Rejected: a reader who reopens a finished row to re-read it would have it snatched shut by the next unrelated re-render — the exact failure the `useRef` guard exists to prevent.

**Adopt the hook in `SkillRow` and `GenericCommandCard` too, for uniformity.** Rejected: the rule requires a current owner and a need. Neither row can expand before it settles, so the hook would be unobservable state machinery and a test that can only assert the absence of a difference.

**Give `CordisRunRow` and `CordisActionRow` a disclosure.** Deferred: both render their output as an unconditional `<pre>` with no collapsed form, so folding them is new interaction surface — a click target, an `aria-expanded` contract, and interaction between the row toggle and the existing `inspect` button — not a lifecycle fix. `packages/extensions/ui-cordis` has no component-test lane to carry it.

**Keep the two-line preview and let settlement fold to it.** Rejected: that is what shipped, and it is what produced the report. A fold that still shows the output box does not read as a fold.

**Remove the card but print the output's line count in the summary.** Rejected: it asks the reader to interpret a number where the row can simply be opened, and the count is the one fact opening answers outright. The summary stays a description of the command.

## Consequences

A running `bash` row now opens, which is the behavior the other tool rows already had, and settling takes its terminal card out of the DOM rather than shrinking it to a preview. The `查看全部` control still only appears past ten output lines, so a running command — which has no output yet — is unaffected by it. `cordis_define` opens while the call is in flight. An ask-user row stays open across its own settlement, which is what its `restingExpanded` comment always claimed.

The contract's regression test is now real: `tool-row.client.spec.tsx` rerenders the same component through running → settled and asserts both the plain collapse and the resting-open case, and `use-lifecycle-expansion.client.spec.tsx` pins the hook's five transitions directly. Three rows share one implementation instead of one row owning it and two copying it.

`assembly-surfaces.client.spec.tsx` drives a `bash` call and a `pwsh` call through the real event stream — `tool/call`, then `tool/result` appended to the live session — and reads the settled DOM instead of a hand-built component tree: the bash row loses its terminal, and the generic row loses its output text. A running row's own assertions came from the same path, which is what proved the lifecycle fix reached the browser before the preview did.

Known gap, unchanged by this note: `CordisRunRow` and `CordisActionRow` still show their output unconditionally and never fold.

## Related

The [command-row copy contract](../architecture/2026-07-30-command-row-copy-contract.md) owns *what* a collapsed command row says; this note owns *whether* a row is collapsed. They meet at `GenericCommandCard`, which keeps the copy rule and has no lifecycle of its own.

[Standard-mode flow row disclosure](../feature/2026-09-02-standard-mode-flow-row-disclosure.md) gave the closed bash row its two-line preview and rejected gating the terminal behind `open`. This note reverses that one decision and keeps the rest of that note's mechanism — the `data-stage` wrapper, the ten-line cap derived from `--dsl-terminal-line-height`, and the `查看全部` control; its `peek` prose describes the stage as it shipped, not as it stands now.
