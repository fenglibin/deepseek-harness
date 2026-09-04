# Agent Note: The user-message drawer pages back until the window holds a prompt

Status: implemented

English | [中文](2026-09-03-user-message-drawer-pages-for-a-prompt.zh.md)

## Problem

`UserTurnPanel` listed only the loaded Turns whose window carried a `user` node, and returned `null` when none did. History paging cuts at the group start of the 50th-from-last append-surface message, and that group start is the Assistant message's own source span, not the Turn boundary, so a session whose newest Turn is long opens on a window that holds Assistant work and no user prompt. The drawer stayed hidden until the reader manually paged back far enough for a user message to enter the window.

Picking an entry whose row is not rendered also did nothing: `navigateToTurn` looked the row up in the DOM and returned silently on a miss.

## Decision

ChatView drives the history itself, with no Host, protocol, or projection change. While the rail holds Turns and none of them carries a prompt, and older history remains, the view requests the previous page through the same anchored path the **Load earlier** button uses, which holds the reader's position while the page lands above them. An empty rail suppresses the request: nothing is loaded yet, so there is no cut to correct.

Picking an entry whose row is absent arms the item as a pending target and requests a page. A landed prepend that renders the target settles the scroll on it through `settleAt`, the same routine a direct navigation uses; a landed page that does not render it keeps paging. Both paths stop when history runs out.

## Alternatives considered

**Show the drawer with an empty list.** Rejected: a badge reading zero and an empty panel give the reader nothing to act on, and the count would misreport a session that has user messages above the window.

**Ask the Host for the newest user Turn, or add a projection.** Rejected: it puts a Chat presentation need on the Session protocol and the durable projection, and every consumer of the log pays for one drawer.

**Unpage the window so the cut always lands on a Turn boundary.** Rejected: it changes the paging contract for every consumer and can pull an unbounded amount of history into the first page, while the reported case is one long Turn.

**Cap the automatic hops at a fixed page count.** Rejected: the loop already terminates on `hasMore`, and a cap would reintroduce the bug for any Turn longer than the cap while adding a tunable no deployment varies.

## Consequences

Opening a session whose newest Turn fills the window now loads older pages until a user prompt lands, which costs one or more extra page requests on that open and leaves the reader where they were. A session with no user prompt anywhere pages to the start of its history and shows no drawer. Navigation is no longer silent when a rail item's row is missing, and the settle reuses one routine for the direct and the paged case, so the two cannot drift.
