# Agent Note: Older-history paging keeps its anchor and settles a picked message

Status: implemented

English | [中文](2026-09-05-chat-paging-pick-settle.zh.md)

## Problem

`ChatView` (`packages/client/ui-chat/src/client/chat/ChatView.tsx`) pages older history in for two readers: one who scrolls into the list top, and one who picks an entry from the user-message drawer. A pick whose turn the loaded window does not hold arms a pending turn and keeps paging until that turn's row renders. Two defects left that reader where they started.

A pick armed from the floor never settled. Re-entering a session with no saved position pins the reader to the floor. While the requested page is in flight the column grows its busy row at the head, the engine reports the compensating position, and the scroll handler reads that delivered position as the reader following again: the at-bottom branch cleared `anchorRef`, and `toBottom` cleared it once more on the snap-back. The prepend branch — the only code that restores a position or settles a pick — runs only while an anchor is armed. Without one, the page that finally carries the picked message in neither restores nor settles, so the reader watched the scrollbar shrink through every page and never reached the message they picked.

The armed pick then hijacked later pages. The paging effect stops asking for pages once the target's row renders, and it never settled or retired the pick, because settling lived only inside the prepend branch. Every later prepend — a reader scrolling up for older history — found the stale pending turn and scrolled the reader back to it, which is why manual scrolling could not get above the turn that had been picked.

A restore also landed one busy row high. The page arrives while the request is still busy, so the busy row is in the column at the commit that measures it and leaves one commit later, moving every row up by its height.

## Decision

`pagingRef` marks an older-history request whose prepend has not landed. Bottom-pinning bookkeeping no longer drops the anchor while one is pending: `toBottom` and the at-bottom branch of the scroll handler keep it, the effect that sees the request end without a prepend drops it, and the back-to-bottom control abandons both the anchor and the pick, because a reader who asks for the floor has cancelled the navigation.

`promisedRef` holds the row and offset a restore promised. The effect that observes the request ending re-reads that row instead of subtracting a recorded height: engines differ — Chrome and Firefox anchor the scroll themselves, Safari does not — so re-reading corrects by exactly the amount the column actually moved and is a no-op where the engine already compensated.

`settledPendingRef` holds one settle closure, read by the prepend branch and the paging effect alike. A pick settles as soon as its row exists, however that row arrived. The prepend branch settles only once the request is no longer busy, because the busy row is still in the column at the commit that lands a page and would put the row one busy row above the reading line; the paging effect settles on the commit the request ends, when the column has stopped moving. The same effect retires a pick that no page can bring in, instead of leaving it armed for a later prepend to act on.

## Alternatives considered

**Settle only from the paging effect.** Rejected: the prepend branch settles before paint, so a pick already inside the loaded window lands without an intermediate frame. Routing every settle through a passive effect paints the restored position first and then jumps.

**Let the prepend branch settle while the request is still busy.** Rejected: the busy row sits in the column at that commit, so the settle under-shoots by its height and stays wrong until the request ends.

**Retire the pick on the reader's next scroll.** Rejected: paging itself delivers scroll positions, and a reader who nudges the scrollbar while the target is loading would silently lose the navigation they asked for.

**Record the busy row's height and subtract it when the request ends.** Rejected: it double-corrects on engines that anchor the scroll themselves. Re-reading the anchored row measures what actually changed.

**Keep paging for a pick the log cannot produce.** Rejected: it spends requests against a target that will never render, and the armed pick is what made later prepends scroll the reader backward.

## Consequences

Picking a user message from the drawer pages back to it and lands it one scroll margin below the top of the scrollport, whether the reader was pinned to the floor or reading mid-history. A later manual page preserves the reader's own anchor instead of snapping to the turn they picked earlier. A restore keeps the offset it promised across the busy row's arrival and departure.

Two regression tests in `packages/client/ui-chat/tests/chat-view.client.spec.tsx` drive the commit sequence the view actually sees — request in flight, page landing, request ending — over a scripted row layout that derives every rect from the live DOM, and assert the settle offset, the drawer's active row, and that a later manual page holds the reader's position.

The existing test `pages until a picked user message renders, then settles on it` never exercised a loaded Turn set that grows: it shares the fixture's timings map across pages, and a shared timings map reuses the previous timeline, so no page could add a Turn and the pick never became loadable. Each page in that test now passes its own timings map.
