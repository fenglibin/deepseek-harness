/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-file-revisions`.
 * @module @deepseek-ai/dsh-session-file-revisions/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-file-revisions'

/** Cordis companion plugin name. */
export const name = 'session-file-revisions-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the capture listener is stateless with respect to
 * cross-cutting relations — it reads the settled tool result's own value and the
 * session the agent belongs to, both owned and runtime-checked by dsh-tools and
 * the session store. The recorded baseline/end-state pair is checked where it is
 * consumed, by the reverse-patch application that refuses to write on conflict.
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
