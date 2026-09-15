/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-http-proxy`.
 * @module @deepseek-ai/dsh-http-proxy/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-http-proxy'

/** Cordis companion plugin name. */
export const name = 'http-proxy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns one process-wide policy value and the dispatcher
 * mirroring it, not an event stream or a cross-plugin mutable relation. Resolution is a pure
 * function of the launch environment, and install/dispose symmetry is exercised by unit tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
