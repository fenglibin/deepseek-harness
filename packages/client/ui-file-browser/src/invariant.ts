/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-file-browser`.
 * @module @deepseek-ai/dsh-client-ui-file-browser/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-file-browser'

/** Cordis companion plugin name. */
export const name = 'client-ui-file-browser-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the browser owns no authoritative state of its own —
 * the tree, the editor buffer, and the open/closed flag are view state derived
 * from, or written back to, the workspace directory through the fileBrowser
 * Remote. There is no cross-plugin mutable relation for an assertion to check.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
