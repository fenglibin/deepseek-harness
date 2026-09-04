---
description: "The user-chosen lightweight model route for users and maintainers deciding which model auxiliary calls such as session titles and compaction summaries should use."
kind: "package-reference"
---

# @deepseek-ai/dsh-lightweight-model

English | [中文](README.zh.md)

## Summary

`dsh-lightweight-model` holds one optional provider/model route that auxiliary model calls use instead of the conversation's own model. Session titles and compaction summaries — the two calls the LLM seam marks with `GenerateOptions.purpose` — consult `ctx.lightweightModel` before falling back to the route the main request used, so a deployment whose conversation model cannot serve a short auxiliary request still gets a working title. The route is empty by default; the user picks one in Settings → Models and a mounted settings provider layers that choice over the composition entry. Choose it when auxiliary calls should run on a cheaper or faster model than the conversation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package when auxiliary model calls should be able to leave the conversation's route. The service answers one question — which route, if any, should auxiliary calls use? — and stays silent when the user set none.

### Configure the route

The composition entry is optional and empty by default. Set both fields together to give a deployment its own base route:

```yaml
- name: '@deepseek-ai/dsh-lightweight-model'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `''` | Registered provider route for auxiliary calls; empty means unset |
| `model` | `''` | Provider-owned model id for auxiliary calls; empty means unset |

Omitting `config` leaves the route empty, which is the shipped default: auxiliary calls then reuse the conversation's own route exactly as they did before this package existed. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lightweight-model) is the exhaustive source for every accepted field.

### Read and change the route

`currentSelection()` returns a detached `{ provider, model }`, or `undefined` while the route is unset. `saveSelection()` stores one route; `clearSelection()` empties it so auxiliary calls follow the conversation again.

```text
const route = ctx.lightweightModel.currentSelection()
if (route !== undefined) dispatch(route)
await ctx.lightweightModel.clearSelection()
```

Without a settings provider both writes are no-ops and the composition entry remains current. The service does not validate catalog membership: a provider route may serve an unadvertised model, and the consumer that opens a request owns availability diagnostics.

### Consume the route

Consumers read the service through `ctx.get('lightweightModel')`, since it is optional, and place it between their own explicit configuration and the inherited conversation route:

```text
const target = configured ?? ctx.get('lightweightModel')?.currentSelection() ?? inheritedRoute
```

Both shipped consumers already do this: [`session-title-llm`](../../session/session-title-llm/README.md) and [`compaction-basic`](../../compaction/compaction-basic/README.md).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The service is a composition entry with a settings-backed source, shaped like [`agent-default-model`](../agent-default-model/README.md): the plugin config supplies the base pair, and the `lightweight-model` settings section becomes the live source once a settings provider is mounted. Because every consumer reads through `currentSelection()`, a settings write needs no registration-level rebuild. The pair is all-or-nothing — a section naming a provider without a model is rejected at the settings boundary rather than at each consumer.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `LightweightModelConfig` service, settings section install, `currentSelection`/`saveSelection`/`clearSelection` |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion |

### Behavior notes

All three public methods are thin reads and writes over that source: `currentSelection()` returns a fresh detached object so a caller can hold it without aliasing service state, and the two writers replace the whole section through `ctx.settings` when present.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [Session title subsystem](../../../docs/subsystems/session-title.md) — durable title state and the auxiliary request record.
- [Shared LLM title policy](../../session/session-title-llm/README.md) — the route, framing, and timeout policy one title call runs under.
- [Lightweight model routing](../../../.agents/notes/implemented/feature/2026-09-04-lightweight-model-routing.md) — why auxiliary calls need their own route, with the measurements behind it.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lightweight-model) — every accepted config field and its source declaration.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the route the service supplies to auxiliary calls; those calls own their own model-visible requests and never enter the conversation history.

#### KV Cache effect

Routing an auxiliary call to another provider means it cannot reuse the conversation's prefix cache. That is the intended trade: title and compaction calls are small, and a route that shares no prefix is preferable to one that cannot complete the call at all.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the service's scope. They are current package constraints, not a task backlog.

- **No persistence without a settings provider** — `saveSelection()` and `clearSelection()` cannot keep a choice for a later process when no settings provider is mounted.
- **No per-task routes** — one route serves every auxiliary call; a deployment that wants a different model for titles than for compaction summaries still configures those consumers' own `provider`/`model` overrides, which sit above this route.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
