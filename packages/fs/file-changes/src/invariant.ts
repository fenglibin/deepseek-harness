/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-file-changes`.
 * @module @deepseek-ai/dsh-file-changes/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-file-changes'

/** Cordis companion plugin name. */
export const name = 'file-changes-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns one pure projection fold whose wire
 * payload the projection registry schema-validates at every snapshot and
 * change-feed emission, and the event relations the fold reads (a `tool/call`
 * preceding its `tool/result`, `tool/result` carrying its call id, monotonic
 * host-assigned seq and turn numbers, append-surface results) are owned and
 * runtime-checked by dsh-agent-loop and the Session surface, not here.
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
