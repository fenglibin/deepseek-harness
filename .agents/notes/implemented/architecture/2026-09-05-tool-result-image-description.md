# Agent Note: Tool-result images are described at result commit

Status: implemented

English | [中文](2026-09-05-tool-result-image-description.zh.md)

## Problem

Prompt admission describes images for the gateway ingress paths (`session/prompt`, `session/updateQueue`), but a tool can produce an image — a screenshot, a rendered chart — after admission. That image rides inside a `tool/result` event, which never passes through the gateway inbox, so a text-only route projected it to `[image omitted because this model accepts text only; attachment sha256:…]`. The tool-result content already flows through the concrete loop, but nothing described it before the durable result was appended.

## Decision

Describe tool-result images where the `tool/result` event is committed: `appendToolResult` in `packages/core/agent-loop/src/tool-calls.ts`.

- **Same consumer, new call site.** `appendToolResult` collects the image references from `result.content` with `collectImageRefs`, calls the existing `describeForRoute(ctx, refs, inputModalities, signal, session.id)`, and attaches the returned descriptions with `attachImageDescriptions` before `createToolResultMessage`. The two `dsh-llm` helpers walk nested tool-result content with the same recursive shape as `replaceImagesForTextModel`, so the described image renders as `describedImageText` on the next text-only projection.
- **Route authority at the call site.** `executeToolCalls` takes the target route's `inputModalities` as a new parameter; the step loop passes `preparedCall.inputModalities`, the exact modalities the request is already dispatching under. An absent declaration means unknown, not text-only, so the loop describes nothing and the projection behaves exactly as before.
- **Degrade, never block the result.** `describeForRoute` already returns no descriptions when the route accepts images, no describer is mounted, or the call fails, so a missing or broken vision route costs the model its description but never the tool result itself.

The gateway-ingress mechanism and the seam roles this note reuses are in [the admission Agent Note](2026-09-05-image-understanding-at-admission.md); the full design is in [the design document](../../../../docs/design/image-understanding-and-inline-images.md).

## Alternatives considered

**Describe inside `projectImagesForTextModel`.** Rejected: projection is a pure function over a frozen message array and cannot call a model.

**Describe in `agent/pre-step`.** Rejected: tool results do not exist at pre-step, and the step's own result content is only available after the tool settles, at the commit point this note chooses.

**Append the result first, then describe and rewrite.** Rejected: a `surfaceOp: replace` rewrite after append diverges the next request's prefix and voids the provider prefix cache; the description must ride the same commit as the result.

## Consequences

- **Bought**: a text-only route reads a bounded account of each tool-produced image instead of an omission notice, for the main agent and any subagent that runs tools through the same loop.
- **Cost**: one extra understanding call per uncached tool-result image, inside the result commit; the call is bounded by the same `timeoutMs`, `maxOutputTokens`, and `maxDescriptionChars` as admission and reuses the per-attachment cache.
- **Loop owns the call site**: `appendToolResult` becomes asynchronous, so the ordered commit already awaits it; the description still lands in the same `tool/result` event, keeping the model-visible text rebuildable from the log.

## Verification findings

`dsh-llm` covers `collectImageRefs` and `attachImageDescriptions` for nested order, the no-change return, and non-mutation. The loop covers three cases over the real runtime with a scripted adapter and a stubbed describer: a text-only route attaches the description, an image-capable route makes no describing call, and a missing describer leaves the image undescribed.

(End of file - total 44 lines)
