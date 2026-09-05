# Agent Note: subagent-acp enable switch (dormant optional provider)

Status: implemented

English | [中文](2026-09-05-subagent-acp-enable-switch.zh.md)

## Problem

`dsh-subagent-acp` registers a `SubagentProvider` the moment it is mounted. A deployment that mounts the row for an optional child agent whose command is absent — for example CodeBuddy on a machine where it is not installed — still pays the registration and any config validation in `apply`, even though the provider can never start a run. The only off-switch was to remove the row from the composition entirely, which also drops the configuration a user may want to keep.

## Decision

Add an `enabled` config field (boolean, default `true`) to `dsh-subagent-acp`. When `false`, `apply` returns before registering the provider and before any field validation, so a dormant row contributes nothing and never fails load. The cordis `disabled` flag on the preset tool row remains the separate agent-plane switch that hides the model-facing delegation tool without unmounting the provider.

### The two switches

- `enabled` (provider config): `false` keeps the backend row dormant — no `ctx.subagents` registration, no validation, no command check. A machine without CodeBuddy loads unchanged even when the row is present.
- `disabled` (cordis tool row): hides the `dsh-tool-subagent` delegation tool while the provider stays registered.

Together they give full control: omit the rows to remove CodeBuddy entirely; set `enabled: false` to keep the configuration dormant; remove `disabled` from the tool row to make CodeBuddy delegable.

### Missing command stays a start-time failure

`enabled` does not add a load-time command check. A missing or non-executable command still fails at the first `start` as `process-start`, because command resolvability is only real at spawn time — the earliest resolvable point. A load-time check would break the shipped contract that a `command` naming an absent binary loads and fails only on `start`, and would probe an environment-dependent fact (PATH, filesystem) the spawn already resolves authoritatively.

### CodeBuddy preset row

The three agent presets (`standard`, `cordis`, `ptc`) gain a `tool-subagent-codebuddy` row (`provider: codebuddy`, `toolName: subagent_codebuddy`, `backgroundMode: one-shot`, `maxDepth: provider-managed`), shipped `disabled: true` like the Codex and Claude Code siblings. CodeBuddy speaks standard ACP, so it reuses `dsh-subagent-acp` on the host plane (`command: codebuddy --acp`) instead of a dedicated backend package.

## Alternatives considered

### Why not a load-time command check?

Verifying the command resolves to an executable at load would break the shipped contract — the [ACP subagent backend](2026-06-22-acp-subagent-backend.md) tests pin that a `command` naming an absent binary loads and fails at the first `start`, not at mount. Command resolvability is also environment-dependent, so a load-time probe would be both fragile and redundant with the existing `process-start` failure.

### Why not a dedicated CodeBuddy backend package?

Codex and Claude Code each need a backend package because they do not speak ACP; see the [Codex and Claude Code providers note](2026-08-04-claude-code-and-codex-subagent-backends.md). CodeBuddy does speak ACP, so `dsh-subagent-acp` with `command: codebuddy --acp` already drives it; a dedicated package would duplicate the ACP client.

## Consequences

An `enabled: false` row contributes nothing to the registry and is never validated, so a composition can carry a dormant optional provider without a running cost or a load failure. The cost is one extra config field on `dsh-subagent-acp`; the `enabled` default (`true`) preserves existing behavior for every current mount. The three presets now carry a disabled CodeBuddy tool row, matching the Codex and Claude Code siblings.
