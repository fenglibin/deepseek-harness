# Agent Note: inline-image composer (rail retirement)

Status: implemented

English | [中文](2026-09-05-inline-image-composer.zh.md)

## Problem

Draft images lived outside the Lexical editor as a flat `imageIds: DraftAttachmentId[]` array owned by the input facade, rendered by a separate attachment rail (`conversation.input.attachments`). Because text and images were two independent currencies, `sendSession` assembled the prompt as `[...serializedImages, ...text]` — images always before text, discarding the interleaving the user placed in the composer. The rail was also a separate scrolling surface, so the draft could not show text and images in one ordered flow.

## Decision

Make an inline image an atomic decorator node in the composer document, and make ordered `DraftPart[]` the single submit currency.

### ImageChipNode (editor/image-node.tsx)

`ImageChipNode` mirrors `ReferenceChipNode`: a `DecoratorNode` with `isInline()` true and `isKeyboardSelectable()` false, whose `getTextContent()` returns `''` (the persistent draft keeps only typed text; browser image bytes never cross reload) and whose detect projection is one U+FFFC. Its decorate renders a thumbnail, an inline remove button, and a click-to-preview lightbox; the remove callback and insert-time display cache (`previewUrl`/`name`/`width`/`height`) ride the node, not serialized state.

### Projection (editor/projection.ts)

`ComposerSegment.kind` gains `'image'`; `$composerLayout` emits an image leaf as `pushLeaf('image', kid, ATOMIC_CHAR, '')` (zero clipboard length), and `$projectComposer` returns an ordered `images: DraftImage[]` (`attachmentId` + clipboard `offset`) beside `occurrences`.

### InputState parts replace imageIds (contract/input.ts)

`DraftPart = {type:'text';text} | {type:'image';attachmentId}`; `InputState.parts` derives from the document in order, and `draft` stays the clipboard projection. `SessionInput.addImages(inserts: DraftImageInsert[])` inserts chips at the caret, and `removeImage(id)` removes the node and releases the registry object through a new `releaseImage` dependency. `pruneImages` is deleted: with the rail gone, every registry release now accompanies a chip removal, so there is no stale-node residue to sweep.

### Ordered submit (service.ts sendSession + hub/facade defaultSink)

`defaultSink` changes from `(text, imageIds, mode, signal)` to `(parts, mode, signal)`; `sendSession` maps parts to `PromptContentPart[]` in document order (text → `{type:'text'}`, image → serialized base64 → `{type:'image'}`), replacing `[...images, ...text]`. The local submission echo (`beginSubmission`) renders the same part order. Failed sends restore image chips to their recorded offsets.

### Rail retirement

The `conversation.input.attachments` slot and ui-attachment's `ComposerAttachments`/`DropOverlay`/`AttachmentRail` are removed; `MessageImages` (transcript rendering) stays. Remove/preview interactions move to the chip decorator, and document-level file drop plus intake limit pre-checks move to the composer's paste/drop handlers (`intakeFiles`). Total-size pre-check leaves the composer: the host enforces it at submit, and the rejection lands as a `session/attachment-invalid` notice through the existing reason-copy mapping. The retired rail was recorded in the [attachment display alignment note](2026-08-11-web-attachment-display-alignment.md) and its slot in the [dynamic render and attachment ownership note](../architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.md); both stay active for their transcript-image and slot-composition decisions.

### Command submissions unchanged

`CommandClaim.submit` still takes a text argument plus a separate `images` list, so the `serializeDraftImages` and command-images channel stay as-is.

## Alternatives considered

### Why inline chips rather than keeping the rail?

A separate rail cannot express interleaving — the submission path had no coordinate to rejoin text and images, which is why it always front-loaded images. Inline nodes give the interleaving a single source (the document order) that both persistence and submit read from.

### Why a zero-width clipboard projection rather than a draft placeholder?

Image bytes are browser-owned and never persist, so the durable draft should stay pure typed text. A zero-width projection keeps `draft` unchanged for persistence while still ordering images in `parts` through the segment walk; a placeholder token would leak into the persisted draft and every model-visible text path.

## Consequences

`InputState.parts` is now the public submit currency for the composer; consumers that read `imageIds` read `parts` instead. `removeImage` owns the registry object release (`releaseImage`), so the hub no longer releases draft images separately on removal. Detached-failure restoration rebuilds image chips at their recorded offsets. Composer intake pre-checks keep format, count, and single-file size, and defer total-size to the host's submit-time rejection.
