/**
 * The credential resolver the manager contributes for the mcp-client instances
 * it mounts. It is the Consumer half of the mcp-client auth seam: an instance
 * asks for one `Authorization` value immediately before it builds a transport,
 * and this resolver answers from the server's stored grant.
 *
 * Two rules shape the answers. A grant that is missing asks the user to
 * authorize (`unauthorized`) rather than reporting a fault, because the user's
 * next action can fix it. A grant that is merely stale is refreshed in place,
 * and the refresh is serialized per server so concurrent mounts cannot each
 * rotate the same refresh token — the seam's `modifyRecord` already excludes
 * concurrent writers, but without this lock two rotations would still race to
 * read the same old token.
 * @module @deepseek-ai/dsh-mcp-manager/auth-sink
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpAuthResolution, McpAuthSink } from '@deepseek-ai/dsh-mcp-client'
import type { McpHttpServer, McpServerEntry } from './config.ts'
import type { McpOAuthGrant } from './oauth-grant.ts'
import { deleteGrant, readGrant, writeGrant } from './oauth-grant.ts'
import { OAuthTokenError, refreshGrant } from './oauth-client.ts'
import type { McpOAuthEndpoints } from './oauth-client.ts'

/** Margin inside which a token counts as expired, so it can never expire mid-request. */
const TOKEN_EXPIRY_SKEW_MS = 30_000

/** Why a resolution failed, in the manager's own words. */
function failure(reason: 'unauthorized' | 'unavailable', error: string): McpAuthResolution {
  return { ok: false, reason, error }
}

/** Whether a stored grant still has an access token worth sending. */
function isUsable(grant: McpOAuthGrant, now: number): boolean {
  return grant.expiresAt === undefined || grant.expiresAt > now + TOKEN_EXPIRY_SKEW_MS
}

/**
 * Contribute the auth sink and return its handle.
 *
 * The resolver answers `undefined` for a server whose entry is `none` or that
 * is not an HTTP server, so an unauthenticated server's behavior is exactly
 * what it was before this seam existed.
 *
 * @param ctx - context carrying `credentials`.
 * @param serverOf - resolves one server's current entry, read fresh per call so
 *   a settings edit takes effect without remounting.
 * @returns the sink to `ctx.provide`, and the pending-authorization registry.
 */
export function createAuthSink(
  ctx: Context,
  serverOf: (serverName: string) => McpServerEntry | undefined,
): McpAuthSink {
  /** Serializes refresh per server: one rotation at a time, one token to rotate. */
  const refreshing = new Map<string, Promise<McpAuthResolution>>()

  const resolveOne = async (serverName: string, force = false): Promise<McpAuthResolution | undefined> => {
    const server = serverOf(serverName)
    // Not an HTTP server, or not an OAuth one: no credential to resolve, so
    // the transport sends only the headers the entry names.
    if (server === undefined || server.transport !== 'streamable-http') return undefined
    const entry: McpHttpServer = server
    // The schema fills `auth` on parse, but an entry built programmatically —
    // or read from a document written before the field existed — may carry
    // none. Absent means `none`, the same default the schema applies.
    if (entry.auth?.kind !== 'oauth') return undefined
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      return failure('unavailable', `server "${serverName}" uses OAuth but this deployment has no credential store`)
    }
    const grant = await readGrant(ctx, serverName)
    // Captured after the discriminant check so the closure keeps the narrowed
    // OAuth shape instead of the union.
    const auth = entry.auth
    const endpoints: McpOAuthEndpoints = {
      authorizationUrl: auth.authorizationUrl,
      tokenUrl: auth.tokenUrl,
    }
    if (grant === undefined) {
      return failure('unauthorized', `server "${serverName}" is not authorized yet`)
    }
    // `force` is the caller reporting that the server rejected a token this
    // resolver still considered valid — a clock skew or a server-side
    // revocation. Renewing is then the only thing left to try, since reusing
    // the same token would repeat exactly what just failed.
    if (!force && isUsable(grant, Date.now())) {
      return { ok: true, authorization: `Bearer ${grant.accessToken}` }
    }
    if (grant.refreshToken === undefined) {
      // Nothing to renew from: the user must authorize again.
      return failure('unauthorized', `server "${serverName}" has an expired token that cannot be refreshed`)
    }
    const inFlight = refreshing.get(serverName)
    if (inFlight !== undefined) return inFlight
    const { clientId, scopes } = auth
    const refreshToken = grant.refreshToken
    const run = (async (): Promise<McpAuthResolution> => {
      try {
        const renewed = await refreshGrant(endpoints, clientId, refreshToken, scopes)
        // RFC 6749 §6 lets a refresh response omit `refresh_token`, in which
        // case the previous one stays valid and must be kept: dropping it here
        // would force the user to authorize again at the next expiry, for a
        // grant the server never revoked.
        const carried: McpOAuthGrant = renewed.refreshToken === undefined
          ? { ...renewed, refreshToken }
          : renewed
        await writeGrant(ctx, serverName, carried)
        return { ok: true, authorization: `Bearer ${carried.accessToken}` }
      } catch (error) {
        const unauthorized = error instanceof OAuthTokenError && error.unauthorized
        if (unauthorized) {
          // The refresh token is dead; keeping it would repeat the failure on
          // every mount and hide the fact that re-authorizing is the fix.
          await deleteGrant(ctx, serverName)
        }
        return failure(
          unauthorized ? 'unauthorized' : 'unavailable',
          `server "${serverName}" token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        refreshing.delete(serverName)
      }
    })()
    refreshing.set(serverName, run)
    return run
  }

  return {
    resolve: (serverName, options) => resolveOne(serverName, options?.force === true),
  }
}
