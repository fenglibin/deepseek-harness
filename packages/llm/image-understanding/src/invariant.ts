/**
 * Package-owned invariant companion for generated image understanding.
 *
 * The service owns no event or data relationship of its own: descriptions
 * reach the session log only through the `user/message` event the prompt
 * admission path appends, which that path's own invariant already covers. The
 * empty installer keeps that absence explicit in composed invariant sets.
 *
 * @module @deepseek-ai/dsh-image-understanding/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-image-understanding'

/** Cordis companion plugin name. */
export const name = 'image-understanding-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: the owning admission path records every description it admits. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
