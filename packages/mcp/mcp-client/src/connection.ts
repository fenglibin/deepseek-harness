/**
 * Connection supervisor: owns the MCP client/transport generations for one
 * plugin instance, keeps the harness tool registry in sync with the live
 * generation, and — when the connection drops — restarts the configured
 * server with bounded exponential backoff.
 *
 * One outage shares one attempt budget (`maxAttempts` consecutive failed
 * attempts, delays doubling from `initialDelayMs` up to `maxDelayMs`). A
 * connection that stays up past the stability window closes the outage, so
 * the next disconnect starts a fresh budget while a crash-looping server —
 * even one whose connects briefly succeed — still exhausts the cap instead of
 * restarting forever. Exhaustion unregisters the server's tools and stops;
 * disposal (including HMR) is the only way back from that state.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createTransport } from './transport.ts'
import { syncTools } from './tools.ts'
import type { ToolBridgeOptions, ToolDisposers } from './tools.ts'
import type { Config } from './index.ts'

/** Automatic reconnect policy for one MCP server connection. */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up for good (default 10). */
  maxAttempts?: number
}

/** Defaults shared by the Config schema and {@link resolveReconnectPolicy}. */
export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

// The SDK's stdio transport owns two two-second termination grace periods.
// Keep one additional second for the process-close event that proves the old
// generation is gone; timing out fails closed instead of overlapping children.
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

/** Fully resolved reconnect policy captured at plugin load. */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

/**
 * Lifecycle state of one server connection, as reported to an optional
 * {@link McpStatusSink}. The supervisor derives it from the same decisions
 * that drive its reconnect loop, so a sink observes exactly the transitions
 * the supervisor already logs.
 */
export type McpConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'needs-auth' | 'disposed'

/** Optional detail carried with one {@link McpStatusSink} report. */
export interface McpStatusDetail {
  /** Diagnostic text for a failure or a reconnect attempt. */
  readonly error?: string
  /** Consecutive failed attempts within the current outage, when reconnecting. */
  readonly attempt?: number
  /** Attempt budget for the current outage, when reconnecting. */
  readonly maxAttempts?: number
}

/**
 * Sink for one server's connection status, provided by the embedding plugin
 * through `ctx.provide('mcpStatusSink', …)` and shared by every mcp-client
 * instance it mounts. Absent by default, in which case the supervisor's
 * behavior is unchanged.
 */
export interface McpStatusSink {
  /**
   * Report one status change. Implementations MUST NOT throw: the supervisor
   * contains and logs a failure, so a management surface can never break the
   * reconnect loop it only observes.
   * @param serverName - the reporting instance's configured `serverName`.
   * @param status - the new lifecycle state.
   * @param detail - optional diagnostic and attempt accounting.
   */
  report(serverName: string, status: McpConnectionStatus, detail?: McpStatusDetail): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional connection-status sink shared by every mcp-client instance in scope. */
    mcpStatusSink?: McpStatusSink
  }
}

/**
 * Why a server's credential could not be resolved. The supervisor turns
 * `unauthorized` into the `needs-auth` status and every other value into
 * `failed`: a missing or expired credential is something the user can fix by
 * authorizing, while an unusable credential store is not.
 */
export type McpAuthFailure = 'unauthorized' | 'unavailable'

/** Outcome of one credential resolution attempt. */
export type McpAuthResolution =
  | { readonly ok: true; readonly authorization: string }
  | { readonly ok: false; readonly reason: McpAuthFailure; readonly error?: string }

/**
 * Resolver for the bearer credential one HTTP server needs, provided by the
 * management surface that mounted this instance (the MCP manager) through
 * `ctx.provide('mcpAuthSink', …)`. Absent by default, in which case the
 * transport carries only the headers the config named.
 *
 * The resolver runs before each transport generation is created, so a refreshed
 * token reaches the very next connection without a restart. It is the only
 * channel by which a token enters this package: the config carries no secret.
 */
export interface McpAuthSink {
  /**
   * Resolve the `Authorization` header value for one server.
   * Implementations MUST NOT throw: the supervisor contains and logs a failure,
   * so an authorization problem can never break the connection loop it feeds.
   * @param serverName - the requesting instance's configured `serverName`.
   * @param options - `force` asks for a token obtained by renewing rather than
   *   reusing one the resolver still considers valid; the supervisor sets it
   *   only for the single retry that follows a 401.
   * @returns the header value to send, why it could not be produced, or
   *   `undefined` when this server needs no credential — in which case the
   *   transport sends only the headers its config named.
   */
  resolve(serverName: string, options?: { force?: boolean }): Promise<McpAuthResolution | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional credential resolver shared by every mcp-client instance a surface mounts. */
    mcpAuthSink?: McpAuthSink
  }
}

/** Result of one credential resolution, or `undefined` when no resolver is mounted. */
type ResolvedAuthorization = McpAuthResolution | undefined

/**
 * Ask the mounted credential resolver for one server's `Authorization` value.
 * A stdio server has no HTTP endpoint to authenticate against, so it never
 * asks; without a resolver the transport falls back to the configured headers.
 *
 * The resolver's contract forbids throwing, but a sink is contributed by
 * another plugin, so a rejection is contained here rather than trusted: an
 * authorization problem degrades to "no credential" instead of taking down the
 * connection loop it only feeds.
 *
 * @param ctx - context optionally carrying `mcpAuthSink`.
 * @param config - this instance's resolved config.
 * @returns the resolution to apply, or `undefined` to send only config headers.
 */
async function resolveAuthorization(ctx: Context, config: Config, force = false): Promise<ResolvedAuthorization> {
  const sink = ctx.get('mcpAuthSink')
  if (sink === undefined || config.transport !== 'streamable-http') return undefined
  try {
    return await sink.resolve(config.serverName, force ? { force: true } : undefined)
  } catch (error) {
    ctx.logger.warn(`mcp-client(${config.serverName}): credential resolver failed: ${String(error)}`)
    return { ok: false, reason: 'unavailable', error: `credential resolver failed: ${String(error)}` }
  }
}

/**
 * Whether one failure means "the server rejected our credential". The MCP SDK
 * surfaces an HTTP status as a `StreamableHTTPError` code; only 401 says the
 * token is the problem, so every other status keeps its ordinary meaning.
 * @param error - the thrown value from a connect attempt.
 * @returns true when a fresh token could plausibly fix it.
 */
function isUnauthorizedError(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 401
}

/**
 * The one explicit resolve step from raw reconnect config to the policy the
 * supervisor runs. Programmatic construction may bypass Schemastery
 * normalization, so every default and bound is re-judged here — misconfiguration
 * fails the plugin instance at load.
 *
 * @param config - Raw `reconnect` config; omission uses the defaults.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The frozen resolved policy.
 */
export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  /* jscpd:ignore-start — domain-specific delay validation parallels llm retry-policy; not extractable */
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path}.maxAttempts must be a positive integer`)
  }
  /* jscpd:ignore-end */
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/** Result from the initial connection attempt, for startup-await semantics. */
export interface ConnectionOutcome {
  /** If the initial connection or tool sync failed, the error; otherwise absent. */
  error?: unknown
}

/** Handle for one plugin instance's supervised connection. */
export interface ConnectionHandle {
  /**
   * Settles when the first connection attempt completes (success or failure).
   * The supervisor enters its reconnect loop regardless; the caller decides
   * whether a failed startup is fatal via `failOnStartupError`.
   */
  ready: Promise<ConnectionOutcome>
  /**
   * Stop reconnection, close the live client, wait for the in-flight attempt
   * and queued tool syncs to quiesce, then unregister every tool this server
   * still owns.
   */
  dispose(): Promise<void>
}

/**
 * Start the supervised connection for one MCP server and keep it alive per
 * the reconnect policy.
 *
 * @param ctx - Cordis context providing the `tools` registry and logger.
 * @param config - Resolved plugin config selecting the transport and server identity.
 * @param policy - Resolved reconnect policy from {@link resolveReconnectPolicy}.
 * @param sink - Optional status sink; when absent the supervisor reports nothing.
 * @param allowedTools - Resolved raw-tool mask; omission admits every listed tool.
 * @returns Handle with a `ready` promise for startup-await and a `dispose` for teardown.
 */
export function startConnection(
  ctx: Context,
  config: Config,
  policy: ResolvedReconnectPolicy,
  sink?: McpStatusSink,
  allowedTools?: ReadonlySet<string>,
): ConnectionHandle {
  const label = `mcp-client(${config.serverName})`
  const opts: ToolBridgeOptions = {
    registrationFailure: 'contain',
    serverName: config.serverName,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    ...allowedTools === undefined ? {} : { allowedTools },
  }
  // The initial sync uses 'throw' when failOnStartupError is configured, so
  // a registration conflict propagates to the startup-await path. Re-syncs
  // and reconnect syncs always contain conflicts.
  const startupOpts: ToolBridgeOptions = config.failOnStartupError
    ? { ...opts, registrationFailure: 'throw' }
    : opts

  let disposed = false
  /** Current generation: the connecting or connected client; undefined during backoff waits and after final failure. */
  let client: Client | undefined
  /** Close signal paired with {@link client}; captured by dispose before current ownership is cleared. */
  let clientClosed: Promise<void> | undefined
  /** Live tool registrations owned by this server; only {@link enqueueSync} and dispose swap it. */
  let disposers: ToolDisposers = new Map()
  let reconnectTimer: NodeJS.Timeout | undefined
  /** Consecutive failed connection attempts within the current outage. */
  let failedAttempts = 0
  /** When the current generation finished connect + initial sync; undefined while down. */
  let connectedAt: number | undefined
  /** The real error from the first connection attempt, for startup-await diagnostics. */
  let firstAttemptError: unknown
  /** Whether this outage already spent its one post-401 renewal retry. */
  let authRetried = false

  /**
   * Report one status change to the optional sink. A sink failure is contained
   * and logged: reporting serves a management surface, never the supervisor.
   * @param status - the new lifecycle state.
   * @param detail - optional diagnostic and attempt accounting.
   */
  const report = (status: McpConnectionStatus, detail?: McpStatusDetail): void => {
    if (sink === undefined) return
    try {
      sink.report(config.serverName, status, detail)
    } catch (error) {
      ctx.logger.warn(`${label}: status sink failed while reporting "${status}": ${String(error)}`)
    }
  }

  /** A generation may act only while it is the current one on a live plugin. */
  const isCurrent = (generation: Client): boolean => !disposed && client === generation

  /**
   * Serializes every syncTools call — initial syncs and notification re-syncs
   * across all generations — so two syncs can never interleave their
   * dispose-previous/register-next swap (which would double-dispose one
   * generation and leak another).
   */
  let syncChain: Promise<void> = Promise.resolve()
  function enqueueSync(generation: Client, syncOpts: ToolBridgeOptions = opts): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      disposers = await syncTools(generation, ctx, syncOpts, disposers)
    })
    // The chain tail must survive a failed sync; the enqueuing caller owns reporting.
    syncChain = run.catch(() => {})
    return run
  }

  /** One disconnect decision per generation: the isCurrent guard makes racing close/error signals idempotent. */
  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return
    client = undefined
    clientClosed = undefined
    scheduleReconnect()
  }

  /** Wait for the transport-owned close signal without letting a broken transport wedge teardown forever. */
  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(false) }, GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      void closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  function scheduleReconnect(): void {
    const lostEstablishedConnection = connectedAt !== undefined
    if (!policy.enabled) {
      const message = lostEstablishedConnection
        ? 'connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect'
      ctx.logger.error(`${label}: ${message}`)
      report('failed', { error: message })
      return
    }
    // A connection that stayed up past the stability window (= maxDelayMs, the
    // longest backoff spacing) ended the previous outage: start a fresh budget.
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      // Enqueue the give-up disposal so it cannot race an in-flight sync's
      // phase-2 swap (which checks isCurrent inside the queue).
      syncChain = syncChain.then(() => {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
      })
      const message = `giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`
      ctx.logger.error(`${label}: ${message}`)
      report('failed', { error: message, attempt: policy.maxAttempts, maxAttempts: policy.maxAttempts })
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    const action = lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'
    ctx.logger.warn(`${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    report('reconnecting', { attempt: failedAttempts, maxAttempts: policy.maxAttempts })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      settling = connectGeneration(false)
    }, delayMs)
    // An armed reconnect timer must never hold the process open on its own.
    reconnectTimer.unref()
  }

  /**
   * One connection attempt: fresh transport + client (the MCP SDK binds a
   * Protocol to one transport for life), connect, then queue the initial tool
   * sync. The startup flag belongs to the attempt rather than the shared sync
   * queue, so an early notification cannot consume strict startup semantics.
   * Every failure funnels through {@link generationDown}; success arms the
   * onclose-driven disconnect path. Never rejects.
   *
   * @param startup - Whether this is the plugin's activation attempt.
   */
  async function connectGeneration(startup: boolean): Promise<void> {
    // Resolve the credential before anything else: a transport is built from
    // it, so an unresolvable credential must cost nothing — no client, no
    // transport, and no reconnect attempt.
    const auth = await resolveAuthorization(ctx, config)
    if (auth !== undefined && !auth.ok) {
      // A credential the user can supply by authorizing stops the loop
      // outright rather than retrying on a backoff schedule: the server is
      // answering correctly, and hammering it would bury the one fact the
      // user needs under repeated warnings.
      const unauthorized = auth.reason === 'unauthorized'
      const credentialError = auth.error ?? (unauthorized
        ? `server "${config.serverName}" requires authorization`
        : `no credential store is available for "${config.serverName}"`)
      ctx.logger.warn(`${label}: ${credentialError}`)
      report(unauthorized ? 'needs-auth' : 'failed', { error: credentialError })
      if (firstAttemptError === undefined) firstAttemptError = new Error(credentialError)
      return
    }
    const generation = new Client(
      { name: 'dsh-mcp-client', version: '0.0.1' },
      { capabilities: {} },
    )
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    let attemptSettled = false
    let closeObserved = false
    const hasClosed = (): boolean => closeObserved
    client = generation
    clientClosed = closed.promise
    // A reconnect attempt keeps the 'reconnecting' state its scheduler already
    // reported with the attempt accounting; only the startup attempt opens the
    // lifecycle, so one outage never emits the same status twice.
    if (startup) report('connecting')
    generation.onclose = () => {
      closeObserved = true
      closed.resolve()
      // A failed connect owns its close barrier in the catch path below. An
      // established generation can transition down directly from this signal.
      if (attemptSettled) generationDown(generation)
    }
    // Registered before connect so a list change during the initial sync is
    // queued behind it rather than dropped.
    generation.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        if (!isCurrent(generation)) return
        ctx.logger.info(`${label}: tool list changed, re-syncing`)
        try {
          await enqueueSync(generation)
        } catch (error) {
          // Fetch-phase failure: the previous generation is still registered
          // and `disposers` still owns it — keep serving the last good list.
          if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
        }
      },
    )
    try {
      await generation.connect(createTransport(config, auth?.authorization))
      if (hasClosed()) {
        attemptSettled = true
        generationDown(generation)
        return
      }
      await enqueueSync(generation, startup ? startupOpts : opts)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      // A 401 says the token, not the server, is the problem: renew once and
      // retry this attempt before handing the failure to the reconnect loop.
      // Retrying here rather than through the backoff schedule is what keeps a
      // rotated token from costing a full delay, and doing it at most once
      // keeps a server that rejects every token from becoming a retry storm.
      if (isCurrent(generation) && !authRetried && isUnauthorizedError(error)) {
        authRetried = true
        const renewed = await resolveAuthorization(ctx, config, true)
        if (renewed !== undefined && renewed.ok) {
          try { await generation.close() } catch { /* transport already gone */ }
          const requiesced = hasClosed() || await waitForClose(closed.promise)
          attemptSettled = true
          if (!isCurrent(generation)) return
          if (requiesced) {
            ctx.logger.info(`${label}: server rejected the credential; retrying once with a renewed token`)
            await connectGeneration(startup); return
          }
        } else if (renewed !== undefined && renewed.reason === 'unauthorized') {
          // The renewal itself was refused: the user must authorize again, so
          // report that instead of a connection fault.
          try { await generation.close() } catch { /* transport already gone */ }
          const requiesced = hasClosed() || await waitForClose(closed.promise)
          attemptSettled = true
          if (!isCurrent(generation)) return
          if (requiesced) {
            const message = renewed.error ?? `server "${config.serverName}" rejected the credential`
            ctx.logger.warn(`${label}: ${message}`)
            report('needs-auth', { error: message })
            return
          }
        }
      }
      // Disposal clears current ownership before it closes the generation, so
      // only a live supervisor reports an attempt failure.
      if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`)
      try { await generation.close() } catch { /* transport already gone */ }
      const quiesced = hasClosed() || await waitForClose(closed.promise)
      attemptSettled = true
      if (!isCurrent(generation)) return
      if (!quiesced) {
        client = undefined
        clientClosed = undefined
        const message = `failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`
        ctx.logger.error(`${label}: ${message}`)
        report('failed', { error: message })
        return
      }
      generationDown(generation)
      return
    }
    attemptSettled = true
    if (hasClosed()) {
      generationDown(generation)
      return
    }
    if (!isCurrent(generation)) return
    connectedAt = Date.now()
    // A live connection closes the outage, so the next one earns its own
    // single post-401 renewal retry.
    authRetried = false
    report('connected')
    if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
  }

  /** The in-flight (or last settled) connection attempt; dispose awaits it for quiescence. */
  let settling = connectGeneration(true)

  // The ready promise settles when the first attempt finishes (regardless of
  // success). If the first attempt fails and reconnect is enabled, the
  // supervisor is already scheduling a retry — ready just reports the outcome.
  const ready: Promise<ConnectionOutcome> = settling.then(() => {
    // After settling: if client is set the initial connect+sync succeeded.
    // If not, the supervisor either scheduled a retry (error logged) or gave
    // up (error logged). Either way the outcome is reported with the real error.
    // Note: settling.then() is a microtask; stdio onclose is a macrotask — so
    // a server that crashes AFTER a successful initial sync cannot flip client
    // to undefined before this continuation runs.
    if (client !== undefined) return {}
    /* v8 ignore next -- defensive: firstAttemptError is always set when connect/sync fails */
    return { error: firstAttemptError ?? new Error(`${label}: initial connection failed`) }
  })

  return {
    ready,
    async dispose(): Promise<void> {
      disposed = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      const current = client
      const currentClosed = clientClosed
      client = undefined
      clientClosed = undefined
      if (current !== undefined) {
        try { await current.close() } catch { /* transport already gone */ }
        if (currentClosed !== undefined && !await waitForClose(currentClosed)) {
          ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal — server shutdown may be incomplete`)
        }
      }
      // Quiesce, don't just request it: the in-flight attempt enqueues its
      // sync before settling, so awaiting both leaves `disposers` final.
      await settling
      await syncChain
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
      report('disposed')
    },
  }
}
