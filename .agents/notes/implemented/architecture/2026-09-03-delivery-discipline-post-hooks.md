# Agent Note: Delivery-discipline post-hooks

Status: implemented

English | [中文](2026-09-03-delivery-discipline-post-hooks.zh.md)

## Problem

B1–B3 gave a task a forward-only lifecycle with record and gate prerequisites, but `accepted` was reachable with no verification beyond the records the model chose to write: nothing ran `openspec validate`, a regression suite, or a deep self-check before acceptance, so the design's "only when all verification passes may the task enter accepted" rear gate (§6.3, §6.4) was missing.

## Decision

Add a `postHooks` command list to the tool policy and run it before a task may reach `accepted`.

- `@deepseek-ai/dsh-tool-delivery` `Config` gains `postHooks?: string[]` (default `[]`), validated as non-empty command strings at `apply`. The package now also injects `shell`.
- `advance_delivery_task` to `accepted` runs each hook in order against the calling agent's session `header.cwd`. A command that exits non-zero, times out, or aborts is the first failure: under `stateful` it blocks acceptance with `DELIVERY_POST_HOOK_FAILED`; under `advisory` it is surfaced as a reminder and acceptance proceeds.

This is batch B4 of the [delivery-discipline design](../../../../docs/design/delivery-discipline-rationale.md): the post-hook framework and failure re-injection. Hooking `openspec validate --strict` into the default `postHooks` is a deployment choice (the bundle can list it), and the deep self-check driver is the same mechanism pointed at a custom script.

## Alternatives considered

**Run post-hooks as a separate `verify` tool.** Rejected: a separate tool re-opens the "model must remember to call it" risk; tying verification to the acceptance advance makes it programmatically unavoidable.

**Block acceptance in the domain service.** Rejected: executing shell commands is a tool-layer deployment policy; the domain stays a pure state machine over durable events.

**Reject only non-zero exits.** Rejected: a hung or killed command must also fail the gate, so timeout and abort are first-class failures.

## Consequences

- **Bought** a programmatic rear gate: acceptance runs the configured commands and follows their result (105 unit tests, 100% coverage).
- **Cost** a `shell` service dependency on the tool package (peer + bundle-resolved `bash`/`subprocess` provider) and an async `advance` path that awaits the hooks before committing.
- **Deferred (unchanged)** the `delivery/artifact-written` session-event projection and the client UI (B5).
