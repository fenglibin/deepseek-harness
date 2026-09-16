/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-api-session-file-revisions`.
 * @module @deepseek-ai/dsh-api-session-file-revisions/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-api-session-file-revisions'

/** Cordis companion plugin name. */
export const name = 'api-session-file-revisions-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the controller's only durable relation is that each
 * Remote method resolves its session's workspace root before touching a path,
 * and the containment refusal is thrown as the operation's own failure rather
 * than recorded as cross-cutting state. The session store and the revision
 * service each own and runtime-check their own records.
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
