/**
 * OAuth authorization for MCP servers, registered as flows with the
 * authorization seam.
 *
 * The seam owns the conversation — one attempt per credential, notices and
 * prompts routed to whoever started the attempt, the check that the flow
 * actually committed its record — and this module owns only the OAuth
 * protocol: PKCE, the redirect endpoint, and the code-for-token exchange. A
 * second authorization protocol arriving as another flow is what that seam
 * exists for, so MCP registers a flow rather than running a parallel attempt
 * lifecycle of its own.
 *
 * Two properties fall out of that split. A profile with no webserver can still
 * authorize: the flow asks the human to paste the redirect URL instead of
 * receiving it on a route, which is the seam's prompt channel rather than a
 * special case here. And the browser-reported origin — not a loopback literal
 * — becomes the redirect base, so a GUI reached over a LAN address redirects
 * the human back to that same address.
 * @module @deepseek-ai/dsh-mcp-manager/oauth-flow
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { McpServerEntry } from './config.ts'
import { beginAuthorization, exchangeCodeForGrant } from './oauth-client.ts'
import type { McpOAuthEndpoints } from './oauth-client.ts'
import { grantKeyOf, writeGrant } from './oauth-grant.ts'

/** Path prefix the callback route is registered under. */
export const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback'

/** How long one authorization attempt may run before it is withdrawn. */
const ATTEMPT_TIMEOUT_MS = 10 * 60_000

/** Why an authorization could not be started. */
export type StartAuthResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string }

/** One in-flight redirect wait: the callback handler resolves it with the code. */
interface CallbackWaiter {
  readonly resolve: (code: string) => void
}

/**
 * Accept the origin a browser reported for this GUI, or explain why not.
 *
 * The redirect base must be an address the human's own browser can reach, and
 * only that browser knows which address it used, so the origin arrives from
 * the page. It is still checked rather than trusted: a redirect target outside
 * this deployment would send the authorization code somewhere else. The port
 * must be the webserver's, which admits loopback, a LAN address, and any host
 * name resolving to the same bound port, while refusing another service's.
 * PKCE remains the security boundary — a stolen code is useless without the
 * verifier, which never leaves this process — so this check is about
 * correctness of the redirect, not about containing a hostile page.
 *
 * @param origin - the `Origin`-style value the page reported.
 * @param port - the webserver's bound port, when one is known.
 * @returns the normalized origin, or the reason it was refused.
 */
function resolveRedirectOrigin(origin: string, port: number | undefined): { ok: true; origin: string } | { ok: false; error: string } {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return { ok: false, error: `"${origin}" is not a valid origin` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `origin "${origin}" must use http or https` }
  }
  if (port !== undefined && parsed.port !== String(port)) {
    return {
      ok: false,
      error: `origin "${origin}" does not address this deployment (expected port ${String(port)})`,
    }
  }
  return { ok: true, origin: parsed.origin }
}

/**
 * Register one authorization flow per OAuth server and expose the start
 * operation a settings surface calls.
 *
 * @param ctx - context carrying `authorization` and optionally `webServer`.
 * @param serverOf - resolves one server's current entry, read fresh so a
 *   settings edit takes effect without re-registering the flow.
 * @param onAuthorized - invoked after a grant is committed, so the manager can
 *   remount the server and pick the new token up.
 * @returns flow registration, the start operation, and a disposer.
 */
export function createOAuthFlow(
  ctx: Context,
  serverOf: (serverName: string) => McpServerEntry | undefined,
  onAuthorized: (serverName: string) => void,
): {
  registerFlow: (serverName: string) => void
  unregisterFlow: (serverName: string) => void
  start: (serverName: string, origin: string) => Promise<StartAuthResult>
  dispose: () => void
} {
  /** Callback waits by OAuth state, resolved by the redirect route. */
  const waiters = new Map<string, CallbackWaiter>()
  /**
   * Redirect base per credential key. The OAuth protocol requires the same
   * `redirect_uri` on the authorization request and on the code exchange, and
   * a flow's `run` may be entered without any `start()` — a headless caller
   * begins the attempt through the seam directly — so the base is recorded per
   * flow and defaulted rather than left to whichever call happened first.
   */
  const redirectOrigin = new Map<CredentialKey, string>()
  /** Flow disposers by serverName. */
  const flows = new Map<string, () => void>()
  /** Servers whose flow is wanted but whose seam has not arrived yet. */
  const wanted = new Set<string>()
  const attemptTimeout = new AbortController()

  /**
   * The authorization seam, read at each use rather than cached.
   *
   * `authorization` is optional, like every seam a headless or ACP composition
   * may omit: signing in has no surface there, while everything else this
   * plugin does still works. Reading it per call is also what makes the
   * ordering irrelevant — an `inject` callback runs on its own turn, so a
   * cached value would be absent for any registration that happened first.
   * @returns the seam, or undefined in a composition without one.
   */
  const seamOf = (): Context['authorization'] | undefined => ctx.get('authorization')

  // The seam may also arrive after this plugin: re-attach the wanted flows when
  // it does, so a composition that mounts authorization later still offers it.
  ctx.inject(['authorization'], () => {
    for (const serverName of wanted) attachFlow(serverName)
  })

  // The route is contributed through ctx.inject so a webserver that loads
  // after this plugin still receives it: `webServer` is optional, and reading
  // it once at construction would leave OAuth permanently route-less in any
  // composition whose load order put the webserver later.
  ctx.inject(['webServer'], (served) => {
    served.effect(() => served.webServer.register({
      kind: 'prefix',
      path: OAUTH_CALLBACK_PATH,
      handler: (req, res) => { completeCallback(req.url ?? '', res) },
    }), 'mcp-manager: oauth callback route')
  })

  /** Hand one redirect's code to the flow waiting on its state. */
  function completeCallback(requestUrl: string, res: ServerResponse): void {
    const url = new URL(requestUrl, 'http://localhost')
    const state = url.searchParams.get('state')
    const waiter = state === null ? undefined : waiters.get(state)
    if (state === null || waiter === undefined) {
      res.statusCode = 400
      res.end('mcp-manager: this authorization callback is unknown or already used')
      return
    }
    // One use per state: the flow owns the exchange, so a replayed redirect
    // must not reach it twice.
    waiters.delete(state)
    const code = url.searchParams.get('code')
    if (code === null || code.length === 0) {
      res.statusCode = 400
      res.end('mcp-manager: this authorization callback carries no code')
      return
    }
    waiter.resolve(code)
    res.statusCode = 200
    // The page the human is left on is the whole success signal; no token and
    // no server data reaches the browser.
    res.end('mcp-manager: authorization received — return to Settings → MCP')
  }

  /**
   * The absolute redirect base for one attempt.
   *
   * A settings page reports its own origin so a GUI reached over a LAN or
   * proxied address redirects back to that address. An attempt begun without
   * one — a headless caller driving the seam, where the human pastes the
   * redirect back rather than the browser following it — falls back to the
   * webserver's loopback address, which is the only address this process can
   * name for itself.
   */
  function callbackUri(serverName: string): string {
    const key = grantKeyOf(serverName)
    const recorded = redirectOrigin.get(key)
    const origin = recorded ?? `http://127.0.0.1:${String(ctx.get('webServer')?.port ?? 3080)}`
    return `${origin}${OAUTH_CALLBACK_PATH}/${encodeURIComponent(serverName)}`
  }

  /**
   * Wait for this attempt's redirect, or for the human to paste the URL when
   * no route can receive it. The two race: whichever arrives first completes
   * the exchange, and the losing prompt is withdrawn individually so the
   * attempt itself stays alive.
   */
  async function obtainCode(
    session: AuthorizationSession,
    serverName: string,
    state: string,
    canReceiveRedirect: boolean,
  ): Promise<string> {
    if (!canReceiveRedirect) {
      // No webserver: the human is the transport. The pasted value may be the
      // whole redirect URL or just its code.
      const pasted = await session.prompt({
        kind: 'text',
        message: `Paste the full URL your browser was redirected to (or just its "code" value) to finish authorizing "${serverName}".`,
      })
      return extractCode(pasted)
    }
    const promptController = new AbortController()
    let settleWaiter: (() => void) | undefined
    const redirect = new Promise<string>((resolve) => {
      waiters.set(state, { resolve })
      settleWaiter = () => { waiters.delete(state) }
    })
    // A withdrawn prompt rejects; that is the expected outcome when the
    // redirect won, so it must not surface as an unhandled rejection.
    const pasted = session.prompt({
      kind: 'text',
      message: `If the browser did not return automatically, paste the URL it was redirected to for "${serverName}".`,
      signal: promptController.signal,
    }).catch(() => undefined)
    try {
      return await Promise.race([redirect, pasted.then(value => value ?? new Promise<string>(() => {}))])
    } finally {
      promptController.abort()
      settleWaiter?.()
    }
  }

  /** Read an authorization code out of whatever the human pasted. */
  function extractCode(pasted: string): string {
    const trimmed = pasted.trim()
    try {
      const parsed = new URL(trimmed)
      const code = parsed.searchParams.get('code')
      if (code !== null && code.length > 0) return code
    } catch {
      /* not a URL: the human pasted the bare code, which the next line takes */
    }
    if (trimmed.length === 0) throw new AuthorizationDeclinedError('no authorization code was provided')
    return trimmed
  }

  /** Request the flow that authorizes one server's grant. */
  function registerFlow(serverName: string): void {
    wanted.add(serverName)
    attachFlow(serverName)
  }

  /** Attach one wanted flow to the seam, when the seam is present. */
  function attachFlow(serverName: string): void {
    if (flows.has(serverName)) return
    const seam = seamOf()
    // No seam: the server still mounts and its stored grant still works, it
    // just cannot start a new authorization.
    if (seam === undefined) return
    const key = grantKeyOf(serverName)
    const dispose = seam.registerFlow({
      key,
      label: `MCP: ${serverName}`,
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        const entry = serverOf(serverName)
        if (entry === undefined || entry.transport !== 'streamable-http' || entry.auth?.kind !== 'oauth') {
          throw new Error(`mcp-manager: "${serverName}" is no longer an OAuth server`)
        }
        const auth = (entry).auth
        const endpoints: McpOAuthEndpoints = {
          authorizationUrl: auth.authorizationUrl,
          tokenUrl: auth.tokenUrl,
        }
        const redirectUri = callbackUri(serverName)
        const request = beginAuthorization(endpoints, auth.clientId, redirectUri, auth.scopes)
        // The notice carries the page the human must open; a surface renders
        // it, and never receives a token.
        session.notify({ message: `Authorize "${serverName}" in your browser, then return here.`, url: request.url })
        const code = await obtainCode(session, serverName, request.state, ctx.get('webServer') !== undefined)
        // Committing through the credentials seam is what makes the attempt
        // report `authorized`: the seam verifies this write happened.
        const grant = await exchangeCodeForGrant(endpoints, auth.clientId, redirectUri, code, request.codeVerifier)
        await writeGrant(ctx, serverName, grant)
      },
    })
    flows.set(serverName, dispose)
  }

  /** Withdraw one server's flow: its attempt, if any, goes with it. */
  function unregisterFlow(serverName: string): void {
    wanted.delete(serverName)
    const dispose = flows.get(serverName)
    if (dispose === undefined) return
    flows.delete(serverName)
    dispose()
    redirectOrigin.delete(grantKeyOf(serverName))
  }

  // The seam owns the attempt lifecycle, so success is observed rather than
  // assumed: the server is remounted only once its record really committed.
  ctx.effect(() => ctx.on('authorization/settled', (key, settlement) => {
    if (settlement !== 'authorized') return
    for (const serverName of flows.keys()) {
      if (grantKeyOf(serverName) !== key) continue
      onAuthorized(serverName)
      return
    }
  }), 'mcp-manager: oauth settlement')

  return {
    registerFlow,
    unregisterFlow,
    async start(serverName, origin) {
      const server = serverOf(serverName)
      if (server === undefined) return { ok: false, error: `no MCP server named "${serverName}"` }
      if (server.transport !== 'streamable-http') {
        return { ok: false, error: `server "${serverName}" is a stdio server and cannot use OAuth` }
      }
      if ((server).auth?.kind !== 'oauth') {
        return { ok: false, error: `server "${serverName}" does not use OAuth` }
      }
      const seam = seamOf()
      if (seam === undefined) {
        return {
          ok: false,
          error: `server "${serverName}" cannot be authorized: this deployment has no authorization seam`,
        }
      }
      if (!flows.has(serverName)) {
        // A disabled entry has no flow: authorizing something the manager does
        // not mount would store a grant nothing reads.
        return { ok: false, error: `server "${serverName}" is disabled` }
      }
      const webServer = ctx.get('webServer')
      const resolved = resolveRedirectOrigin(origin, webServer?.port)
      if (!resolved.ok) return { ok: false, error: resolved.error }
      const key = grantKeyOf(serverName)
      if (seam.describe(key)?.inFlight === true) {
        return { ok: false, error: `server "${serverName}" already has an authorization in progress` }
      }
      redirectOrigin.set(key, resolved.origin)

      let publishUrl: (url: string) => void = () => {}
      const urlReady = new Promise<string>((resolve) => { publishUrl = resolve })
      const attempt = seam.begin({
        key,
        method: 'oauth',
        interaction: {
          notify: (notice) => {
            if (notice.url !== undefined) publishUrl(notice.url)
          },
          // The settings page has no prompt surface: the redirect route is
          // this deployment's answer channel. Declining keeps the seam's
          // semantics exact — a refused prompt is a `cancelled` attempt.
          prompt: () => Promise.reject(new AuthorizationDeclinedError('the MCP settings page does not answer prompts')),
        },
        signal: attemptTimeout.signal,
      })
      // The attempt outlives this call: the redirect completes it later, and
      // its failure must not surface as an unhandled rejection.
      void attempt.catch((error: unknown) => {
        ctx.logger.warn(`mcp-manager: authorization for "${serverName}" failed: ${String(error)}`)
      })
      const timeout = setTimeout(() => {
        seamOf()?.cancel(key)
      }, ATTEMPT_TIMEOUT_MS)
      timeout.unref()
      try {
        const url = await urlReady
        return { ok: true, url }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        clearTimeout(timeout)
      }
    },
    dispose: () => {
      attemptTimeout.abort()
      waiters.clear()
      redirectOrigin.clear()
      for (const dispose of [...flows.values()]) dispose()
      flows.clear()
    },
  }
}
