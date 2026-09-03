# Agent Note: The Chat surface exposes a user-message drawer that mirrors the rail's active mark

Status: implemented

English | [中文](2026-09-03-chat-user-turn-panel-drawer.zh.md)

## Problem

Long Chat sessions — easily a few dozen turns on a real design or coding task — are unreadable in any flat scroll. The Chat view already shipped a compact right-rail navigation widget (the [`TurnNavigator`](../../../../packages/client/ui-chat/src/client/chat/TurnNavigator.tsx)) that lets a reader jump to any loaded turn by clicking a tick, but the rail is one column wide and each tick only unfolds a small preview on hover. A reader who wants to *browse* their own questions — to remind themselves which turn number asked what — has to scroll the rail tick by tick and read two short preview lines for every hover, which is too slow for the actual use case ("which turn told the model to switch to Compact mode?").

The data the rail renders is also exactly what the user wants in a list: `ChatTurnNavigationIndex` already projects every loaded turn into `{ turn, anchorKey, prompt, response }`, and `navigateToTurn` already scrolls to any turn on demand. The missing surface is a list — a panel-sized, prose-readable counterpart that the rail can't be.

## Decision

**One new client-only component, [`UserTurnPanel`](../../../../packages/client/ui-chat/src/client/chat/UserTurnPanel.tsx), sits beside `TurnNavigator` inside the Chat scrollport and renders either a circular badge or a vertical drawer.** The two widgets read the same `turnNavigationItems` selector and the same `activeTurn` state, so the badge count, the drawer list, the rail mark, and the currently highlighted row all stay in lockstep. The component is a plain React tree of `div` / `button` / `ol` / `li` elements — no slot registration, no service contract, no new dictionary namespace beyond the four `chat.userTurnList.*` keys that already localize the rest of Chat's chrome.

**Filtering is reactive and case-based, not type-based.** A turn whose `prompt` field is empty — the loaded window starts mid-turn, the assistant-only steps in a compaction summary, unknown surfaces — drops out of the drawer because it isn't a user message; the rest render in timeline order. The badge hides the same way when nothing remains, so an empty session never sees the new chrome at all.

**Outside-pointer dismissal reuses [`useDismissOnOutsidePointer`](../../../../packages/client/ui-primitives/src/useDismissOnOutsidePointer.ts), and `Escape` close is a one-line `useEffect` on `document.keydown`.** Both detach on close. Picking a row hands the item back to the parent (`ChatView`) and closes immediately, matching the affordance of any popover menu: the new chrome never stays open while the reader inspects the result of the jump.

## Alternatives considered

**Extend the existing rail with a 1-line preview per tick plus click affordances.** Rejected: the rail is anchored to a 28-pixel column by design (it gives the reader constant visible feedback during fast scrolling), and widening it competes with the width axis the Chat column already shares with the input card. A panel is a separate widget, not a wider rail.

**Promote the drawer to a modal `Modal` component.** Rejected: a modal owns the page while it is open, and the user wants to see the conversation behind it (preview the next turn, scroll while reading). `role="dialog"` with `aria-modal="false"` is the explicit affordance for that case.

**Drive the badge count from a parallel user-message count across the full session, including unloaded history.** Rejected: every other navigation widget on the surface — the rail, the "load older" button, `activeTurn` itself — works on the loaded window, and the UI surfaces that window in copy ("load more to see earlier turns"). A drawer that quietly counts unloaded turns would force a second, opaque source of truth into a surface the user can already inspect.

## Consequences

A reader with 17 user prompts in a session sees a #17 badge sitting where the rail sits; one click reveals a vertically ordered list of every loaded user prompt with its first-line preview, and another click on any row drops them exactly onto the corresponding message and folds the panel away. The feature touches three files inside `packages/client/ui-chat/src/client/chat`, four keys in `locale.ts`, six unit tests in a new spec, and zero downstream packages.

The trade-off is a small surface that has to agree with the rail. Both widgets read the same `useChat(s => s.navigation.items())` selector and the same `activeTurn` state — the drawer piggybacks on the rail's invariants rather than re-deriving its own — so any future change to how the Chat snapshot projects turn navigation will land on both at once. Six unit tests pin the four behaviors a reader can see (badge count, list ordering, list size after filtering, picking a row → navigate + close, outside-pointer and Escape close, empty session hides the chrome), and the existing `chat-view.client.spec.tsx` 76-case suite still passes unchanged, which is the regression net for the wiring.
