---
description: "Generated text for images a model route cannot read, for users sending images to text-only models and maintainers wiring the vision route that describes them."
kind: "package-reference"
---

# @deepseek-ai/dsh-image-understanding

English | [中文](README.zh.md)

## Summary

This package gives a model route that cannot accept images a written account of them. When a submitted message carries images and the selected route declares text-only input, the package asks one vision-capable model route to describe each image and attaches the result to the durable image block, so the target model later reads bounded text instead of an omission notice. A route that already accepts images is left alone: it receives the compressed request image it receives today and no describing call is made. A deployment with no image-capable model behaves exactly as before, because an unavailable describer yields no description rather than an error.

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

Mount the plugin and, unless the deployment's first image-capable model is the right describer, name the vision route to use. Nothing else is required: the admission path asks for descriptions only when the target route needs them.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-image-understanding'
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `''` | Provider route of the describing model; empty auto-selects the first registered model advertising image input |
| `model` | `''` | Model id on `provider`; set together with `provider` |
| `instruction` | versioned default | Instruction sent with each image; part of the route identity |
| `maxOutputTokens` | `512` | Output token cap for one description |
| `timeoutMs` | `30000` | End-to-end deadline for one understanding call |
| `maxDescriptionChars` | `4000` | Characters retained from one description |
| `requestImagePixelBudget` | `1048576` | Total-pixel budget for one request image in an understanding call |
| `requestImageMaxBytes` | `1048576` | Encoded-byte target for one request image; the smallest quality-ladder output is used when no quality fits |
| `maxCacheEntries` | `64` | Attachment descriptions retained per route |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-image-understanding) is the exhaustive source for every accepted field and its JSDoc.

### What happens when you submit an image

An image submitted to a route that accepts images changes nothing. An image submitted to a text-only route is described once at admission, and the durable `user/message` event carries both the image block and that description; the target model then reads the description where it would otherwise read an omission notice. A deployment with no image-capable model keeps rejecting nothing extra: the image is admitted and the model reads the omission notice, exactly as it does today.

### What can go wrong

A configured route that is not registered, or a model whose declared input modalities omit `image`, fails the first understanding call rather than falling back, so a misconfiguration is visible in the log instead of silently degrading every image. A single image whose call times out, errors, or returns no text contributes no description while its neighbours still succeed. Every other failure is logged and degrades to the omission notice; no failure rejects the user's message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Observable behavior is fully covered in [Use this package](#use-this-package).

### Design decisions

- **Describe at admission, not in the loop.** The gateway knows the authoritative route and catalog metadata when it admits a prompt, while the request waterfall resolves the route later; attaching descriptions where the durable `user/message` is built keeps one owner for the text the model will read.
- **Describe only what the route cannot read.** The decision is the target route's declared `inputModalities`, and an absent declaration means unknown rather than text-only, so an unknown route is never silently downgraded.
- **Degrade, never block.** Every failure after a usable route exists — timeout, provider error, empty completion — yields no description for the affected image and leaves the message admitted.
- **The instruction is route identity.** Changing it changes the form of every description a deployment produces, so it joins provider and model in the cache key.

### Call path

`describeForRoute` in [`src/consumer.ts`](src/consumer.ts) is the only entry the admission path needs: it returns no descriptions when the route accepts images or no service is mounted, and otherwise delegates to the mounted `ImageUnderstanding`. `LlmImageUnderstanding` in [`src/index.ts`](src/index.ts) resolves its route once — validating a configured pair against `resolveModelInfo`, or scanning `listModels` for the first model advertising image input — then serves each reference from a bounded cache or one streamed call under a `deadline` timeout. Its request carries the image block and the instruction in one user message with `purpose: 'image-understanding'`; the first text block is trimmed, truncated at a code-point boundary, and cached. `projectImagesForTextModel` in `dsh-llm` renders a description when the durable block carries one and the omission notice when it does not.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition `ImageUnderstanding`, provider `LlmImageUnderstanding`, route resolution, cache, and bounded calls |
| [`src/consumer.ts`](src/consumer.ts) | Admission-side helper: decide and delegate, degrading on every failure |
| [`src/types.ts`](src/types.ts) | Route and result vocabulary |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; descriptions reach the log through the `user/message` event the admission path appends) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

For the capability seam this package plugs into, read the LLM and attachment subsystem references.

- [LLM streaming subsystem reference](../../../docs/subsystems/llm-streaming.md) — the `ctx.llm` surface, model metadata, and streaming requests.
- [Attachment subsystem reference](../../../docs/subsystems/attachment.md) — durable image references and request projection.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-image-understanding) — every accepted config field and its source declaration.
- [Design: image understanding and inline images](../../../docs/design/image-understanding-and-inline-images.md) — the seam, placement, and scope decisions behind this package.

-----

<a id="model-experience"></a>
## Model Experience

### The describing call, when the target route declares text-only input

#### What the model sees

One user message containing the image block followed by the instruction text. The image block carries the durable normalized attachment, so the vision model sees the stored image itself.

##### Instruction sent with each image

```markdown
Describe what this image shows for a reader who cannot see it. Transcribe visible text verbatim, including labels, code, and error messages. Answer in plain prose with no preamble.
```

#### Token effect

Conditional: one image and the instruction per call, with output capped by `maxOutputTokens`. A route that accepts images produces no call and no tokens.

#### KV Cache effect

Independent model request: it shares no prefix with the agent loop, so it neither reuses nor invalidates the loop's cache. Repeated identical calls may reuse the describer's own provider-side cache.

### The description text on the admitted message

#### What the model sees

For a text-only route, the target model reads the description where it would otherwise read the omission notice, in the same position the image occupied. `<model>` is the describing model id, `<digest>` is the attachment digest, and `<text>` is the generated description; a route that accepts images sees the image block and no description text:

##### Description rendered in place of the image

```markdown
[image description generated by <model>; attachment sha256:<digest>: <text>]
```

#### Token effect

Replacing: the image's request tokens are replaced by bounded text, capped at `maxDescriptionChars`.

#### KV Cache effect

The description is fixed when its owning event is committed — the admitted `user/message` or the committed `tool/result` — so the durable event is append-only and preserves the prefix before it. The bounded cache can re-serve one attachment's text across turns without changing it.

## Known Limitations and Deferred Work

These limits describe what this package can and cannot do; they are current package constraints.

- **Gateway ingress and tool results only** — descriptions attach where a route is resolved for the caller: the Remote `session/prompt` and `session/updateQueue` admission paths, and the loop's `tool/result` commit in `dsh-agent-loop`. A subagent, ACP, or other in-process caller that builds a `user/message` block directly still gets the omission notice, because no admission path resolves its route for it.
- **One image per call** — images in one message are described independently, so a batch costs one call per uncached image and cannot share a prefix.
- **Per-process cache** — retained descriptions live in memory for the life of the mounted service, so a restart re-describes an attachment the session log still references.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and the package code.

#### Open question: callers that build content blocks directly

A subagent, ACP, or other in-process caller that assembles a `user/message` block without going through gateway admission still gets the omission notice, because nothing resolves a target route for it. Closing that gap needs one place those callers share with the gateway, and no such seam exists yet.

</details>
