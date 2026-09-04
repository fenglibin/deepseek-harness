# Agent Note: Delivery-discipline tools wired into Web presets

Status: implemented

English | [中文](2026-09-03-delivery-tools-web-preset-wiring.zh.md)

## Problem

The delivery-discipline capability shipped in the base bundle (`delivery` + `tool-delivery`, batches B1–B5) but never reached a Web session. The Web surface disables every base agent-plane tool row and lets each session mount a preset instead, yet `tool-delivery` was neither disabled there nor mounted by any preset, and no system-prompt section told the model when to use the tools. The result: a coding agent in the Web app fell back to `todo_write` to track work, so no `.dsh/changes/` or `.dsh/design/` artifact was ever written and the design/spec gates were silently bypassed.

A second, independent gap: the `todo_write` conversation row expanded to the raw JSON arguments rather than a readable list.

## Decision

Wire the delivery tools into the Web surface the same way as `tool-goal`:

- `packages/bundle/web-app/cordis.patch.yml` disables `tool-delivery` alongside the other agent-plane tools, and each tool-bearing preset (`standard`, `cordis`, `ptc`) mounts `@deepseek-ai/dsh-tool-delivery` with `enforcement: stateful` next to `tool-todo`.
- `@deepseek-ai/dsh-tool-delivery` now injects `systemPrompt` and registers a `tool:delivery` guidance section (order `TOOL_DELIVERY` = 2450), telling the model to prefer the delivery tools over `todo_write` when work must leave a design or change record, and to copy the exact `task_id`/`revision`.
- The `todo_write` conversation row now renders a structured `TodoCard` list (status marker + task text + localized status label) instead of the raw JSON args; unusable args fall back to the raw body.

## Alternatives considered

**Keep the delivery tools host-plane only.** Rejected: the Web surface's preset model moves every agent-plane tool behind a preset; leaving `tool-delivery` on the host plane while disabling its siblings was exactly the asymmetry that hid it from sessions.

**Rely on the tool descriptions alone.** Rejected: the delivery tools' descriptions are abstract; without a dedicated guidance section the model defaults to `todo_write` because that matches its task-list habit.

**Reuse the input-dock `TodoPanel` for the conversation row.** Rejected for the row: `TodoPanel` is the composer dock's live projection of `todos`; the conversation row needs a plain card derived from the call's arguments, not the session projection.

## Consequences

- Bought: a Web coding agent now sees and is guided toward the delivery tools, so larger work records `.dsh/changes/` / `.dsh/design/` artifacts and passes the design/spec gates; the `todo_write` row expands to a readable list.
- Cost: a `@deepseek-ai/dsh-system-prompt` peer dependency and tsconfig reference on `tool-delivery`, one new `TOOL_DELIVERY` section order, and a new `TodoCard` client component plus three `todo.status.*` locale keys.
- Testing: three new tests (preset mounting, guidance section, structured list expansion); the `tool-delivery`, `system-prompt`, `ui-tool`, `ui-conversation`, client-i18n, and cordis-config gates all pass.
