# Agent Note: lightweight model routing for auxiliary calls

Status: implemented

English | [中文](2026-09-04-lightweight-model-routing.zh.md)

## Problem

Session titles came from a truncation fallback instead of the LLM title that the shipped composition already requests. Every session in a local sample of twelve logged `session/title-llm-request`, and none logged a `provider`-sourced `session/title`: the auxiliary request ran, failed, and the service kept the first-five-words fallback.

The failure is a property of the route, not of the caller. The default route `tencent-tokenplan / hy4-preview` answers the title request with `finish_reason: length`, `completion_tokens: 64`, `completion_tokens_details.reasoning_tokens: 64`, and an empty `content` — the whole output budget goes to reasoning and no title is ever emitted. `session-title-llm` maps `max-tokens` to an error, so the fallback sticks deterministically.

Raising the cap does not help on that route. Budgets of 128, 256, 512, 1024, 2048, and 4096 all return `finish_reason: length` with `reasoning_tokens` equal to the cap and empty `content`, and 4096 takes 73 seconds; the captured reasoning text shows the model restating the prompt in place. Every thinking-disabling knob on that endpoint is ignored — `enable_thinking: false`, `reasoning_effort: minimal`, `thinking: { type: 'disabled' }`, `thinking: { enabled: false }`, `chat_template_kwargs.enable_thinking`, and `extra_body.enable_thinking` all leave `reasoning_tokens` at the budget ceiling, with the system prompt passed both as a top-level body key and as a `messages` entry.

A different route completes the same task. `tencent-tokenhub-llm / glm-5.3-flash` with `max_tokens: 256`, the same prompt and input, returns `finish_reason: stop` in 6.8 seconds with 228 reasoning tokens and the content `优化会话标题生成：调用LLM总结用户提问`. Two facts follow: 64 output tokens is below what any thinking route needs for a title, and a deployment can have a conversation route that cannot serve an auxiliary request — with no deployable way to make that route stop thinking.

The repo carried no record of whether lightweight tasks should use a separate lightweight model; a search of `docs/design/`, `docs/`, and `.agents/notes/` including `archived/` found none.

## Decision

`GenerateOptions.purpose` — whose only members are `'compaction'` and `'session-title'` — is the repo's existing definition of an auxiliary model call, so lightweight routing serves exactly those two calls and nothing else.

`@deepseek-ai/dsh-lightweight-model` adds the `lightweight-model` settings namespace and the `ctx.lightweightModel` service. The section is `{ provider: string, model: string }` with both defaulting to `''`; both empty means unset. A write naming a provider without a model is rejected at the settings boundary by the `installSection` `validate` hook rather than at each consumer. `currentSelection()` returns `undefined` while the route is unset, so no consumer needs a separate enabled check. The composition entry can give a deployment a base route, and the settings document layers the user's choice over it.

Consumers read the optional service with `ctx.get('lightweightModel')` and place it between their own explicit configuration and the inherited conversation route:

| Caller | Resolution order |
|---|---|
| `session-title-llm` | config `provider` + `model` → lightweight model → `request/header` route |
| `compaction-basic` | `summarizationProvider` + `summarizationModel` → lightweight model → latest routed request → `AgentOptions` |

Because the service is optional and read through `ctx.get`, a composition that does not mount the package behaves exactly as before and no consumer changes its `inject`.

The base bundle raises the title call's `maxOutputTokens` from 64 to 512 — above the 228 reasoning tokens `glm-5.3-flash` measured, with room to spare — and `targetCjkCharacters` from 10 to 20 to match the requested title length.

Settings → Models gains a lightweight-model card that picks one route from `session.modelCatalog()` or clears it, built on the pattern `packages/client/ui-settings-plugins` already uses for its subagent model selection card: catalog load, revision-fenced settings write, staged select/save/discard. When the settings document is not writable the card is read-only and never reports a save that did not happen.

## Alternatives considered

- **Raise `maxOutputTokens` only** — the cheapest change, and it is wrong on the default route: 4096 still returns empty content, at 73 seconds per title.
- **Add a general disable-thinking switch** — every mechanism the endpoint could accept is ignored, so the switch would be configurable in name only.
- **Hard-code the user's private provider in the base bundle** — private routes belong to a user-level `~/.dsh/profiles/*/cordis.patch.yml`, and the repository ships no such route.
- **Extend the `agent-default-model` namespace with lightweight fields** — that section is the flat three-field answer to "which model does a new agent start from"; folding auxiliary routing into it would make one document carry two unrelated questions.
- **Per-task lightweight routes** — rejected as the first shape; each consumer already owns explicit `provider`/`model` overrides that sit above the shared route, so a deployment needing a different model per task uses those.

## Consequences

A deployment whose conversation model cannot complete an auxiliary request can now point that request elsewhere, and one that never sets a route keeps byte-identical behavior. `session-title-llm` and `compaction-basic` each gained regression tests pinning the unchanged path and tests pinning the new precedence.

The cost is that an auxiliary call routed to another provider cannot reuse the conversation's prefix cache. That is accepted: title and compaction requests are small, and a route that shares no prefix beats one that never completes.

Routing does not probe model capability. If the user selects a route that also cannot serve the auxiliary call, the title still falls back — the choice is the user's, and no automatic fallback chain beyond the documented resolution order exists.
