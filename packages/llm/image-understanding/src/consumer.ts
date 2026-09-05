/**
 * Admission-side consumer: decide whether one target route needs generated
 * image text and, when it does, ask the mounted service for it. Every failure
 * degrades to "no description", so a missing or broken vision route costs the
 * model its description but never costs the user their message.
 *
 * @module @deepseek-ai/dsh-image-understanding/consumer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, ModelModality } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageDescriptionResult } from './types.ts'

/**
 * Whether one route's declared input modalities exclude images. An absent
 * declaration means unknown rather than capable, so only an explicit omission
 * of `image` is a text-only route.
 * @param modalities - declared input modalities of the exact route, or `undefined`.
 * @returns whether images bound for that route must be replaced by generated text.
 */
export function routeExcludesImages(modalities: readonly ModelModality[] | undefined): boolean {
  return modalities !== undefined && !modalities.includes('image')
}

/**
 * Describe every image when the target route cannot accept images.
 * @param ctx - host context carrying the optional image-understanding service.
 * @param refs - durable normalized attachments in owning-message order.
 * @param modalities - declared input modalities of the exact target route.
 * @param signal - cancellation for the understanding calls.
 * @param sessionId - owning session, stamped on the understanding call so replay
 * routes it to the same recorded session as the owning message.
 * @returns one description or `undefined` per reference, aligned by index; every
 * entry is `undefined` when the route accepts images, no describer is mounted,
 * or understanding failed.
 */
export async function describeForRoute(
  ctx: Context,
  refs: readonly ImageAttachmentRef[],
  modalities: readonly ModelModality[] | undefined,
  signal?: AbortSignal,
  sessionId?: GenerateOptions['sessionId'],
): Promise<readonly ImageDescriptionResult[]> {
  if (refs.length === 0 || !routeExcludesImages(modalities)) return refs.map(() => undefined)
  const service = ctx.get('imageUnderstanding')
  if (service === undefined) return refs.map(() => undefined)
  try {
    return await service.describe(refs, signal, sessionId)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`image-understanding: describing ${refs.length} image(s) failed: ${reason}`)
    return refs.map(() => undefined)
  }
}
