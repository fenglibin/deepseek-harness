/** Package-owned invariant companion. @module @deepseek-ai/dsh-api-file-browser/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-api-file-browser'

/** Cordis companion plugin name. */
export const name = 'api-file-browser-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the file browser owns no authoritative state — every
 * answer is a fresh read of the workspace directory, and a write publishes
 * through one rename. There is no cached projection for an assertion to compare
 * against, so an invariant here would only restate a syscall.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
