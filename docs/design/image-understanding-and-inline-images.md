# Image Input and Automatic Image Understanding Design

English | [中文](image-understanding-and-inline-images.zh.md)

This document records the design of two coupled features: editing images inline in the session input so they interleave with text, and automatic image understanding so a model route without image input still receives what an attached image shows. It is the basis for implementation and acceptance. The "why" behind each decision and the alternatives given up live in the Agent Note added with the implementation.

## 1. What exists today

Five mechanisms shape the design space.

The wire form already carries ordered content. `PromptContentPart` is a union of a text part and an image part, `SessionPromptRequest.content` is an array of them, and `durablePromptContent()` in `../../packages/api/session-controller/src/commands.ts` maps each part to a content block in order. The host therefore preserves interleaving; only the client discards it, because `sendSession` in `../../packages/client/ui-conversation/src/client/service.ts` builds `[...images, ...text]` and always places images ahead of the text.

Request-image compression already exists. `AttachmentStore.readImageRequest()` in `../../packages/attachment/attachment/src/index.ts` takes an `ImageRequestPolicy` of `maxPixels` and `maxBytes`, rescales the stored normalized image, and re-encodes it through a quality ladder. Both adapters call it before serializing an image-capable request.

A text-only route already gets a substitution. `LlmRuntime` in `../../packages/llm/llm/src/index.ts` reads `inputModalities` from the resolved model info and, when `image` is absent, replaces every image block with the fixed placeholder produced by `textOnlyImageText()` in `../../packages/llm/llm/src/content.ts`. The model is told an image was omitted; it is told nothing about the image.

The gateway rejects image input for such a route. `prompt()` in the session controller throws `session/attachment-invalid` with `MODEL_DOES_NOT_SUPPORT_IMAGES` before any message is admitted, so the user sees an error instead of a sent message.

The client keeps images outside the editor. `InputState.imageIds` in `../../packages/client/ui-conversation/src/client/contract/input.ts` is a flat ordered array beside the text draft, and the thumbnails render in a rail above the input through the `conversation.input.attachments` slot.

Two repo invariants bind the design. Everything model-visible must be reconstructable from the session log, and `llm/stream` hands listeners a deep-frozen loop-built request whose content is a pure function of that log, so a listener reads it and never rewrites it.

## 2. Requirements

1. A user can place images anywhere in the draft: paste, drag, or pick, and the image lands at the caret between text.
2. Submission sends text and images in the order they appear in the draft.
3. A model route without image input still receives the image content, as generated text, with no user-visible error and no extra step.
4. An image-capable route keeps receiving the compressed request image it receives today.
5. The session log stays the single source of truth for what the model saw.
6. Which vision route performs the understanding is configuration, not a constant.

## 3. Decisions

### 3.1 Decision A: one capability seam, `ctx.imageUnderstanding`

A new package owns all three roles of a capability seam. The Service Definition declares what a description is and when one is unavailable; the Service Provider calls one configured vision route through `ctx.llm`; the Consumer decides, per step, which images must be described. The package sits under `packages/llm/`, next to the capability it consumes, and is mounted as an ordinary Cordis config entry.

### 3.2 Decision B: describe at prompt admission, not at `agent/pre-step` and not at the request boundary

`agent/pre-step` is the wrong place because it runs before the `agent/request` waterfall resolves the actually-dispatched route, so a listener there cannot know the target route's input modalities and would have to describe every image for every route. The request boundary is the wrong place because the content there is deep-frozen and unlogged. `durablePromptContent()` in the session controller and its SDK twin in `../../packages/sdk/server/src/server.ts` are the authoritative points: each already resolves the target route's `inputModalities` to admit encoded images, so each calls the describer with those modalities and the owning `sessionId`, attaching each result to the image block the loop then appends to the log. The `sessionId` binds each understanding call to the same recorded session as the owning message, so keyless replay routes it there.

### 3.3 Decision C: the description rides on the image block

`ImageBlock` gains an optional `description` carrying the text and the identity of the route that produced it. The block keeps its `attachment`, so adapters, transcripts, and compaction keep working unchanged, and the request projection stays a pure function of the log. A separate `image/described` event would store one description per attachment per session instead of one per occurrence, but it would add a `SessionEventMap` member, which every build that does not know the type refuses on read, and it would need a join step at message assembly. The chosen carrier costs one stored copy per occurrence and lets a per-session cache keep the vision call count at one per attachment.

### 3.4 Decision D: the gateway rejection survives only where it is still true

`prompt()` keeps its check, but only rejects when the route lacks `image` **and** no describer route is available. Where a describer exists the prompt is admitted and the understanding happens at the next step. A deployment with no vision route keeps today's explicit `session/attachment-invalid` failure rather than silently degrading to a placeholder.

### 3.5 Decision E: inline images become editor nodes, and an ordered part list replaces `imageIds`

Images move into the Lexical document as one atomic decorator node per attachment, modelled on `ReferenceChipNode`, and the projection learns the new segment kind. The submit currency becomes an ordered list of text and image parts derived from the document, replacing the separate `imageIds` array. The wire and the host need no change for this.

### 3.6 Decision F: the attachment rail retires

Once images live in the draft, the rail above it keeps only a second, unordered intake path. `packages/client/ui-attachment` and the `conversation.input.attachments` slot go away, and the limit pre-check that ran against the rail moves to the paste and drop handlers.

## 4. Host-side design

### 4.1 Service definition

`ctx.imageUnderstanding` exposes the route currently in force, or `undefined` when this deployment cannot describe images, and one `describe()` call taking an ordered batch of durable references. It answers an array aligned by index with its input, where `undefined` means that image has no description, so a caller falls back to the existing placeholder. A silent failure is a legal answer; a thrown error is reserved for a misconfigured route.

### 4.2 LLM-backed Service Provider

Configuration carries `provider`, `model`, the instruction text, an output bound, a timeout, and the request-image policy used for the understanding call. Empty `provider` and `model` mean auto-selection: pick the first registered model whose `inputModalities` includes `image` and log the choice. A configured route is validated on first use and must advertise image input, so a text-only route configured here fails loudly. The call itself reuses the request-image ladder to describe a compressed image, then streams one request through `ctx.llm` with a new `image-understanding` purpose and the owning `sessionId`, and takes the first text block, exactly as the compaction summarizer drives an auxiliary call.

### 4.3 Consumer at prompt admission

`describeForRoute` runs only when the resolved target route lacks image input. `durablePromptContent()` in the session controller and its SDK twin call it with the admitted encoded images, the route's `inputModalities`, and the owning `sessionId`; it resolves each undescribed attachment through the service with a per-route cache so one attachment costs one vision call, and returns one description or `undefined` per reference, index-aligned with its input. Failure, timeout, and cancellation degrade to no description and log a warning; they never block admission. The controller attaches each result to its image block, so the description reaches the log with the message.

### 4.4 Request projection

`projectImagesForTextModel()` keeps its shape and gains one branch: an image block carrying a description renders as that description with its source route named, and an image block without one renders the existing omission placeholder. Both texts are fixed model-visible strings and both are pinned by snapshot coverage.

## 5. Client-side design

### 5.1 The image node

`ImageChipNode` is an inline, non-keyboard-selectable decorator node holding the draft attachment id plus the display cache the thumbnail needs. Backspace removes it whole and arrow keys step across it in one move, matching the reference chip. Its text projection is empty, so the persisted draft keeps holding only typed text, which matches the fact that browser-owned image bytes never survive a reload.

### 5.2 Projection

`ComposerSegment.kind` gains `image`, and the layout walk gives each image one atomic character in the detection view and nothing in the clipboard view. `EditorProjection` gains an ordered `images` list alongside `occurrences`, so the shell can derive the part list by walking document order rather than by splitting a text string.

### 5.3 Submission

`InputState` publishes the derived part list, `addImages` and `removeImage` become editor edits at the caret instead of array appends, the default sink takes parts instead of a text plus an id array, and `sendSession` maps parts straight onto `PromptContentPart`. The local echo takes the same part list so a pending bubble shows the interleaving the user composed. Command claims keep today's semantics: text arguments plus a separate image list.

### 5.4 Intake and the rail

Paste, drop, and the toolbar button all take one path that inserts at the current selection. The removal and preview affordances that lived on rail thumbnails move onto the chip, and the localized copy they use moves with them.

## 6. Deferred scope

Tool results can contain images, for example a screenshot tool, and those never pass through the gateway inbox. The loop describes them at the `tool/result` commit through the same seam ([Agent Note](../../.agents/notes/implemented/architecture/2026-09-05-tool-result-image-description.md)).

## 7. Verification

Host behavior is covered by unit tests over the service, the projection branch, and the consumer, plus one REAL-composition test that boots a text-only route with a stubbed describer and asserts the model-visible request text. A keyless recorded-session snapshot pins the model-visible placeholder and description texts. Client work adds component coverage for insertion at the caret, deletion, and ordered submission, and `pnpm run test:gui` and `DSH_SNAPSHOT=replay pnpm run test:web` cover the assembled composer.

## 8. Open questions

Admission resolves the route authoritatively, so a listener that later rewrites the route can at worst waste one describing call; the image block keeps its attachment, so an image-capable route still receives the image and a text-only one still receives the description. Whether the few seconds of extra latency before the first step warrants a non-blocking composer notice is a product call; the design assumes a short localized notice while understanding runs.
