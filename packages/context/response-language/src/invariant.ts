/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-response-language`.
 * @module @deepseek-ai/dsh-response-language/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-response-language'

/** Cordis companion plugin name. */
export const name = 'response-language-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the row's only contribution is one prompt section
 * registered through `ctx.effect`, so disposal is the prompt registry's own
 * registered relation, and the section's text is a pure function of immutable
 * configuration, the settings document, and the process environment. The
 * package holds no mutable state of its own to audit.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
