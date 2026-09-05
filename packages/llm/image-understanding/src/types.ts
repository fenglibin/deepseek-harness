/** Generated-image-understanding vocabulary. @module @deepseek-ai/dsh-image-understanding/types */

import type { ImageDescription } from '@deepseek-ai/dsh-llm'

/** Text generated for one image, or `undefined` when this deployment produced none. */
export type ImageDescriptionResult = ImageDescription | undefined

/**
 * One exact vision route plus the versioned instruction it uses. The
 * instruction belongs to the route identity because changing it changes the
 * form of every description it produces.
 */
export interface ImageDescriberRoute {
  /** Registered provider route serving the understanding call. */
  provider: string
  /** Provider-owned model id that must advertise image input. */
  model: string
  /** Instruction the describer sends with each image. */
  instruction: string
}
