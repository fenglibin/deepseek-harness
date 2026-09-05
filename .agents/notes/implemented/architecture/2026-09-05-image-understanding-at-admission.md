# Agent Note: Image understanding is attached at prompt admission

Status: implemented

English | [中文](2026-09-05-image-understanding-at-admission.zh.md)

## Problem

A model route that declares text-only input replaced every image with `[image omitted because this model accepts text only; attachment sha256:…]`, so a submitted screenshot, layout, or table was invisible to the model and the only remedy was to switch models. Two candidate placements existed for generating replacement text, and neither the loop nor the projection layer can own it: `agent/pre-step` runs before the `agent/request` waterfall resolves the actual route, and `projectImagesForTextModel` is a pure function over messages that cannot call a model.

## Decision

Add the `image-understanding` capability seam and attach descriptions where the durable `user/message` is built.

- **Service Definition** `ImageUnderstanding` in `packages/llm/image-understanding/src/index.ts` answers two questions: `resolveRoute()` returns the vision route in force (or `undefined` when no registered model accepts images), and `describe(refs, signal?, sessionId?)` returns one description or `undefined` per reference, index-aligned with its input, stamping the owning `sessionId` on each understanding call.
- **Provider** `LlmImageUnderstanding` resolves its route once — validating a configured `provider`/`model` pair through `ctx.llm.resolveModelInfo`, or scanning `listModels` for the first model advertising image input — then serves each reference from a bounded cache or one streamed call under a `deadline` timeout. Its request carries the image block and the instruction in one user message with `purpose: 'image-understanding'`.
- **Consumer** `describeForRoute` in `src/consumer.ts` is the only entry the gateway needs. It returns no descriptions when the route accepts images or no service is mounted, and otherwise delegates with the owning `sessionId`, degrading to no description on any failure.
- **Attachment point**: `durablePromptContent` in `packages/api/session-controller/src/commands.ts` and its SDK twin in `packages/sdk/server/src/server.ts` already resolve the target route's `inputModalities` to admit encoded images, so each now calls `describeForRoute` with those modalities and the owning `sessionId`, attaching each result to its image block. `projectImagesForTextModel` renders `describedImageText` when the block carries a description and the omission notice when it does not.
- **Admission relaxation**: the text-only rejection survives only as the no-describer case — `prompt` rejects with `MODEL_DOES_NOT_SUPPORT_IMAGES` only when no describer can serve the route.

The full seam design, including the inline-composer and coverage decisions this note does not own, is in [the design document](../../../../docs/design/image-understanding-and-inline-images.md).

## Alternatives considered

**Describe in `agent/pre-step`.** Rejected: pre-step runs before the request waterfall resolves the route, so it cannot know the target route's modalities; it would have to describe every image for every route and waste a call on every image-capable one. The gateway already resolves the authoritative route at admission.

**Emit a separate session event for the description.** Rejected: the description belongs to the content the model reads in the same turn, and a second event would have to be re-joined at replay while duplicating the attachment identity the image block already carries.

**Describe inside `projectImagesForTextModel`.** Rejected: projection is a pure function over a message array and is called on history as well as on the current turn; it has no context, no route, and no permission to call a model.

**Store only the description and drop the image block.** Rejected: an image-capable route selected later in the same session must still receive the image, so the durable block keeps both.

## Consequences

- **Bought**: a text-only route reads a bounded account of each image instead of an omission notice, with no configuration as soon as any registered model advertises image input. A deployment with no such model behaves exactly as before.
- **Cost**: one extra model call per uncached image at admission, bounded by `maxOutputTokens`, `timeoutMs`, and `maxDescriptionChars`; descriptions are cached per attachment and route for the life of the mounted service only.
- **Changed vocabulary**: `ImageBlock` gained an optional `description`, `dsh-llm` exports `attachmentDigest` and `describedImageText`, `GenerateOptions.purpose` gained `'image-understanding'`, and `GenerateOptions.requestImagePolicy` lets a caller override the route's request-image compression policy.
- **Narrowed coverage**: descriptions attach where a route is resolved for the caller — the gateway ingress paths and the loop's `tool/result` commit ([tool-result note](2026-09-05-tool-result-image-description.md)). A subagent, ACP, or other in-process caller that builds a `user/message` block directly still gets the omission notice; that gap is recorded in the package README rather than closed here.

## Verification findings

The provider and consumer are covered by unit tests over the real LLM runtime with a scripted adapter, and the projection branch is covered in `dsh-llm` for both the described and undescribed cases. The admission path is covered through the Session Controller Remote, asserting both that a text-only route with a describer admits the message with a description attached and that an image-capable route makes no describing call.

Two gates rejected the first cut and shaped the final placement. The Typert Cordis catalog requires every service to map to one subsystems page and every signature type to be classified, which is why `scripts/gen-cordis-catalog.ts` maps `ctx.imageUnderstanding` to `llm-streaming.md` and exempts the two package-owned types against the package README. The package invariant gate accepts the empty installer only because the description reaches the session log through the `user/message` event the admission path already appends, so this package owns no event or data relationship of its own.
