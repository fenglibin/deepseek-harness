# CodeBuddy ACP Provider

English | [中文](codebuddy-acp-provider.zh.md)

> Status: analysis and design complete, awaiting confirmation (implementation on hold)
> Audience: maintainers and decision makers
> Related request: expose a locally installed CodeBuddy as one model-service source over the Agent Client Protocol (ACP), with parity to existing DSH models; add a switch controlling whether the CodeBuddy ACP call is enabled; document configuration for maximum user control.

---

## 1. Background and motivation

DeepSeek Harness (DSH) composes model backends through two capability seams. The `llm` seam (`dsh-llm` `LlmAdapter`) models a single stateless chat-completion call, whose multi-turn loop DSH drives; the `subagent` seam (`dsh-subagent` `SubagentProvider`) delegates a task to a child agent that runs autonomously and returns a final result. CodeBuddy is a complete coding agent, not a text model: it reasons, calls its own tools, edits files, and only then reports a final answer. It therefore matches the `subagent` seam, not the `llm` seam.

CodeBuddy exposes the standard Agent Client Protocol in two forms: `codebuddy --acp` over stdio (ndJsonStream) and `codebuddy --serve` (or `--acp-transport streamable-http`) over HTTP. DSH already ships `dsh-subagent-acp`, a generic out-of-process ACP backend that spawns any ACP agent and drives it with the `@agentclientprotocol/sdk` client over stdio — the same protocol and transport CodeBuddy speaks natively. This design reuses that backend to mount CodeBuddy as a delegable provider, and adds an enablement switch so a deployment without CodeBuddy is unaffected.

---

## 2. Goals

- Mount a locally installed CodeBuddy as a delegable provider with no new ACP client: reuse `dsh-subagent-acp` and point its `command` at `codebuddy --acp`.
- Keep the user experience consistent with existing external-agent providers (`codex`, `claude-code`): the provider appears as a subagent backend and a model-facing delegation tool, enabled only when the user opts in.
- Add an explicit switch that controls whether the CodeBuddy ACP call is enabled, so a machine without CodeBuddy loads and runs unchanged.
- Expose every CodeBuddy control the CLI offers (`command`, `args`, `permission`, `cwd`, `env`) through configuration, giving the user full control over how CodeBuddy is spawned and what it may do.

## 3. Non-goals

- Do not implement a `LlmAdapter` over ACP: a `session/prompt` is a full autonomous agent run, not a single chat-completion turn, and tool-call semantics cannot be handed back to the DSH loop.
- Do not write a new CodeBuddy-specific backend package: CodeBuddy speaks standard ACP, so `dsh-subagent-acp` already covers it; the Codex and Claude Code backends exist only because those agents do not speak ACP.
- Do not support continuable CodeBuddy children in this design: ACP children are one-shot, and the existing backend limitation stays.
- Do not surface CodeBuddy's internal tool traffic or reasoning into the parent session: the backend returns only the final `agent_message_chunk` text.

---

## 4. Current state

### 4.1 DSH delegation seams

| Component | Package | Role |
|---|---|---|
| Subagent service | `dsh-subagent` | Named-provider registry; `start()` publishes a child run and returns its final result |
| ACP backend | `dsh-subagent-acp` | Spawns one child process per run and drives it as an ACP client over stdio (`ndJsonStream`) |
| Delegation tool | `dsh-tool-subagent` | Model-facing tool binding one `ctx.subagents` provider name to a tool |
| Codex / Claude Code backends | `dsh-subagent-codex` / `dsh-subagent-claude-code` | Same delegation seam, non-ACP transports; preset tool rows ship `disabled: true` by default |

`dsh-subagent-acp` config today: `providerName`, `command`, `args`, `cwd`, `permission` (`allow` | `reject`), `env`, `disposeEofGraceMs`, `disposeGraceMs`. It advertises no start-time capabilities (`agentOptions`, `outputSchema`, `depthLimit`, `toolFilter`, `persona` are all `false`), so the tool row for an out-of-process provider uses `backgroundMode: one-shot` and `maxDepth: provider-managed`.

### 4.2 CodeBuddy ACP surface

CodeBuddy is an ACP-compatible coding agent. `codebuddy --help` documents the controls relevant here:

- `--acp` starts ACP mode over stdin/stdout using `ndJsonStream` — the transport `dsh-subagent-acp` already drives.
- `--acp-transport stdio | streamable-http` selects the wire; `--serve` exposes the HTTP service (the localhost port plus `/api/v1/acp` REST surface).
- `--model`, `--effort`, `--tools` (restrict or disable built-in tools), `--permission-mode`, `--mcp-config`, `--system-prompt`, `--max-turns`, and `--session-id` control the child run.

The ACP session flow is `initialize` → `session/new` → `session/prompt`, streaming `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `interruption_request`, and `session_end` updates; the backend already consumes this flow and keeps only the final text.

### 4.3 Reference implementation (CodeMate)

A sibling project drives CodeBuddy through `codebuddy -p` (subprocess) and `@tencent-ai/agent-sdk`. That path works but owes hundreds of lines to string parsing and version-compatibility shims (`normalizeModelId` for a `--model` naming change, manual timeout via `Promise.race`, `extractLoginUrl`, Node-version checks). DSH reuses the ACP protocol instead, so none of that parsing is needed; only the configuration ideas (permission mode, tool restriction, model selection, retry) transfer over as config fields.

---

## 5. Options considered

### Option A: `LlmAdapter` over ACP (rejected)

Map ACP `session/prompt` events onto `StreamChunk`. Rejected because a `session/prompt` is one full autonomous agent run, not one model turn: CodeBuddy uses its own tool set, so DSH cannot hand tool calls back, and every DSH loop turn would become a nested agent run. The text stream works, but the tool semantics are wrong.

### Option B: reuse `dsh-subagent-acp` with `command: codebuddy` (chosen)

CodeBuddy speaks standard ACP over stdio, which `dsh-subagent-acp` already drives. No new ACP client and no new backend package are needed; the change is configuration plus an enablement switch.

### Option C: a CodeBuddy-specific backend package (rejected)

Mirror `dsh-subagent-codex`. Rejected because Codex and Claude Code need dedicated packages only because they do not speak ACP; CodeBuddy does, so a dedicated package would duplicate `dsh-subagent-acp`.

**Decision**: Option B, plus a new `enabled` switch on the backend config and a documented preset tool row.

---

## 6. Recommended design

### 6.1 Composition

Two rows cooperate, exactly like the shipped Codex and Claude Code providers:

1. **Host plane** — register the provider by mounting `dsh-subagent-acp` pointed at CodeBuddy:

```yaml
- id: subagent-codebuddy
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: codebuddy
    enabled: true
    command: codebuddy
    args: ['--acp']
    permission: reject
```

2. **Agent plane** — expose the model-facing tool, shipped disabled so a machine without CodeBuddy is unaffected:

```yaml
- id: tool-subagent-codebuddy
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codebuddy
    toolName: subagent_codebuddy
    backgroundMode: one-shot
    maxDepth: provider-managed
```

The `subagents` registry itself stays on the host plane; the preset only contributes the tool, matching the existing `delegation` group.

### 6.2 Enablement switch

Add one field to the `dsh-subagent-acp` config: `enabled` (boolean, default `true` when the plugin is mounted).

- `enabled: true` (default) registers the provider with behavior identical to today; a missing or non-executable `command` still fails at the first `start` as `process-start`, because command resolvability is only real at spawn time — the earliest resolvable point.
- `enabled: false` registers nothing and performs no validation, so a deployment without CodeBuddy loads unchanged even if the row is present.
- The cordis `disabled` flag on the tool row remains the agent-plane switch: it hides the delegation tool without unmounting the provider.

Together the two switches give full control: omit the rows to remove CodeBuddy entirely; set `enabled: false` to keep the configuration dormant; remove `disabled` from the tool row to make CodeBuddy delegable.

### 6.3 Configuration surface

The existing `dsh-subagent-acp` fields already expose the controls CodeBuddy offers; `args` carries the CLI flags verbatim:

| Field | Meaning |
|---|---|
| `command` | Executable to spawn for each run (e.g. `codebuddy`) |
| `args` | CLI flags, e.g. `['--acp', '--model', 'deepseek-v4-pro']` |
| `cwd` | Working directory override; defaults to the delegating session's cwd |
| `permission` | `reject` (decline every prompt) or `allow` (approve the first allow option) |
| `env` | Extra child environment layered over the credential-scrubbed parent env |
| `disposeEofGraceMs` / `disposeGraceMs` | Teardown graces |

A `--model` or `--effort` override passes through `args`; `--tools ""` disables CodeBuddy's built-in tools for text-only work; `--mcp-config` injects MCP servers. These map one-to-one from the CodeBuddy CLI, so no new schema is required beyond `enabled`.

---

## 7. Risks and rollback

| Risk | Impact | Mitigation |
|---|---|---|
| A deployment enables CodeBuddy without installing it | The first delegation fails | The preset tool row ships `disabled`, so the tool is absent until enabled; a missing command fails at the first `start` as `process-start` with a diagnostic naming the provider and stage |
| ACP children cannot honor `agentOptions` / `depthLimit` | The tool row must stay `one-shot` + `provider-managed` | The seam already rejects unsupported capabilities at start rather than ignoring them |
| Intermediate CodeBuddy tool activity is invisible to the parent | The parent sees only the final answer | Documented as the backend's existing contract; ACP still surfaces `interruption_request` for permission decisions |
| CodeBuddy CLI flags change across versions | `args` string breaks | Flags are user-owned config, not code; a break is a user-editable value, unlike the CodeMate hard-coded parsing |

**Rollback**: `enabled: false` (or unmounting the rows) removes the capability; `dsh-subagent-acp` and `dsh-subagent` are untouched, no loop change, no new session-event formats.

---

## 8. Confirmed decisions

| # | Decision point | Conclusion |
|---|---|---|
| 1 | Which seam | `subagent` (delegation), not `llm` (model service) |
| 2 | Which backend | Reuse `dsh-subagent-acp`; no new backend package |
| 3 | Transport | `codebuddy --acp` stdio `ndJsonStream` |
| 4 | Enablement switch | New `enabled` config field (default on) plus the existing cordis `disabled` tool-row flag |
| 5 | Missing-command behavior | Unchanged: with `enabled: true`, a missing command fails at the first `start` as `process-start` (no load-time command check) |

---

> Once confirmed, implementation lands the `enabled` field on `dsh-subagent-acp`, its config schema and tests, a preset tool row (disabled by default), and an Agent Note, following existing repository conventions.
