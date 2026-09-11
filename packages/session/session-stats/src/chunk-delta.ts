/**
 * The first-token predicate shared by this package's timing folds: a chunk
 * counts as a token when it delivers non-empty model output, which is what
 * both the whole-log session fold and the per-turn timing fold watch for.
 *
 * @module @deepseek-ai/dsh-session-stats/chunk-delta
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'

/**
 * Whether a stream chunk carries a non-empty first-token delta.
 * @param chunk - stream chunk carried by an `assistant/chunk` event.
 * @returns true when the chunk delivers output the provider counts as a token.
 */
export function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}
