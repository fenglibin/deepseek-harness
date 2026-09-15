/**
 * OAuth authorization-code flow for one MCP server: builds the authorization
 * request, exchanges the returned code for a grant, and renews a grant from its
 * refresh token.
 *
 * This module owns the wire shape of the OAuth exchange and nothing else. It
 * never persists a token (see `oauth-grant.ts`) and never decides what a
 * missing token means for the connection (see the auth sink in `manager.ts`).
 * Discovery is deliberately absent: the server entry supplies the authorization
 * and token endpoints, so a server that requires discovery is out of scope for
 * this flow.
 * @module @deepseek-ai/dsh-mcp-manager/oauth-client
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { McpOAuthGrant } from './oauth-grant.ts'

/** OAuth endpoints one MCP server exposes. */
export interface McpOAuthEndpoints {
  /** Authorization endpoint the browser is sent to. */
  readonly authorizationUrl: string
  /** Token endpoint the code and refresh exchanges POST to. */
  readonly tokenUrl: string
}

/** One pending authorization request, held between the redirect out and the callback back. */
export interface PendingAuthorization {
  /** Opaque correlation id matching a callback to its request. */
  readonly state: string
  /** The URL to send the user's browser to. */
  readonly url: string
  /** PKCE verifier, required to complete the exchange; never sent to the browser. */
  readonly codeVerifier: string
}

/** Error surfaced when a token endpoint answers with a failure. */
export class OAuthTokenError extends Error {
  /**
   * @param message - diagnostic text including the server's own description when it sent one.
   * @param unauthorized - whether the failure means the grant is no longer usable.
   */
  constructor(message: string, readonly unauthorized: boolean) {
    super(message)
    this.name = 'OAuthTokenError'
  }
}

/** The PKCE challenge method this flow uses; `plain` is intentionally unsupported. */
const CODE_CHALLENGE_METHOD = 'S256'

/** Derive the S256 challenge from a verifier. */
function codeChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Begin one authorization: mint a state and PKCE verifier, then build the URL.
 * The verifier stays on the Host — only its challenge crosses to the server.
 *
 * @param endpoints - the server's authorization endpoint.
 * @param clientId - client identifier registered with the server.
 * @param redirectUri - where the server sends the browser back to.
 * @param scopes - scopes to request; omission requests none.
 * @returns the pending authorization, whose `state` identifies the callback.
 */
export function beginAuthorization(
  endpoints: McpOAuthEndpoints,
  clientId: string,
  redirectUri: string,
  scopes?: readonly string[],
): PendingAuthorization {
  const state = randomUUID()
  const codeVerifier = randomBytes(32).toString('base64url')
  const url = new URL(endpoints.authorizationUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallengeOf(codeVerifier))
  url.searchParams.set('code_challenge_method', CODE_CHALLENGE_METHOD)
  if (scopes !== undefined && scopes.length > 0) url.searchParams.set('scope', scopes.join(' '))
  return { state, url: url.toString(), codeVerifier }
}

/** Parse one token-endpoint response into a grant. */
async function parseGrant(response: Response): Promise<McpOAuthGrant> {
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null
      ? String((body as { error_description?: unknown; error?: unknown }).error_description
        ?? (body as { error?: unknown }).error ?? '')
      : ''
    // A 4xx on the token endpoint means the grant itself is bad — expired,
    // revoked, or never valid. Only that class asks the user to authorize
    // again; a 5xx is the server's problem and must not discard a good grant.
    const unauthorized = response.status >= 400 && response.status < 500
    throw new OAuthTokenError(`token endpoint returned ${response.status}${detail === '' ? '' : `: ${detail}`}`, unauthorized)
  }
  if (typeof body !== 'object' || body === null) throw new OAuthTokenError('token endpoint returned no JSON object', false)
  const payload = body as Record<string, unknown>
  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new OAuthTokenError('token endpoint returned no access_token', false)
  }
  const grant: {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    scopes?: readonly string[]
  } = { accessToken: payload.access_token }
  if (typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0) {
    grant.refreshToken = payload.refresh_token
  }
  if (typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)) {
    grant.expiresAt = Date.now() + payload.expires_in * 1000
  }
  if (typeof payload.scope === 'string') grant.scopes = payload.scope.split(/\s+/).filter(scope => scope.length > 0)
  return grant
}

/**
 * Exchange an authorization code for a grant.
 * @param endpoints - the server's token endpoint.
 * @param clientId - client identifier registered with the server.
 * @param redirectUri - the same redirect URI the authorization request used.
 * @param code - the authorization code the callback received.
 * @param codeVerifier - the PKCE verifier minted with the request.
 * @returns the grant to persist.
 * @throws {OAuthTokenError} when the exchange fails.
 */
export async function exchangeCodeForGrant(
  endpoints: McpOAuthEndpoints,
  clientId: string,
  redirectUri: string,
  code: string,
  codeVerifier: string,
): Promise<McpOAuthGrant> {
  const response = await fetch(endpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString(),
  })
  return parseGrant(response)
}

/**
 * Renew a grant from its refresh token.
 * @param endpoints - the server's token endpoint.
 * @param clientId - client identifier registered with the server.
 * @param refreshToken - the grant's refresh token.
 * @param scopes - scopes to request; omission lets the server decide.
 * @returns the replacement grant.
 * @throws {OAuthTokenError} when the refresh fails; `unauthorized` marks a grant
 *   the user must replace by authorizing again.
 */
export async function refreshGrant(
  endpoints: McpOAuthEndpoints,
  clientId: string,
  refreshToken: string,
  scopes?: readonly string[],
): Promise<McpOAuthGrant> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })
  if (scopes !== undefined && scopes.length > 0) params.set('scope', scopes.join(' '))
  const response = await fetch(endpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: params.toString(),
  })
  return parseGrant(response)
}
