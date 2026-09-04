/**
 * MCP manager service: mounts one mcp-client instance per enabled server
 * entry, reconciles the live set against settings changes, and records the
 * connection status each mounted instance reports through the shared sink.
 * @module @deepseek-ai/dsh-mcp-manager/manager
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { McpConnectionStatus, McpStatusDetail, McpStatusSink } from '@deepseek-ai/dsh-mcp-client'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Side-effect type imports: declaration-merge `ctx.settings` and `ctx.tools`.
import type {} from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type { McpServerEntry } from './config.ts'
import { MCP_SETTINGS_NAMESPACE, MCP_SETTINGS_SCHEMA, validateServers } from './config.ts'
import type { McpSettings } from './config.ts'
import { reconcile } from './reconcile.ts'
import type { McpServerStatusKind, McpServerStatusView } from './status.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional MCP manager, queried by configuration surfaces for live status. */
    mcpManager?: McpManager
  }
}

/** One server's live connection status, observed through the status sink. */
export interface McpServerStatus {
  /** The latest lifecycle state the supervisor reported. */
  readonly status: McpConnectionStatus
  /** Optional diagnostic and attempt accounting from the latest report. */
  readonly detail: McpStatusDetail | undefined
}

/** Project a supervisor status onto the client-safe kind, folding `disposed` into `unknown`. */
function statusKindOf(status: McpConnectionStatus | undefined): McpServerStatusKind {
  if (status === undefined || status === 'disposed') return 'unknown'
  return status
}

/** Convert one settings entry into the mcp-client config the bridge validates. */
function toMcpClientConfig(server: McpServerEntry): McpClient.Config {
  if (server.transport === 'stdio') {
    return McpClient.Config({
      transport: 'stdio',
      serverName: server.serverName,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
    })
  }
  return McpClient.Config({
    transport: 'streamable-http',
    serverName: server.serverName,
    url: server.url,
    headers: server.headers,
  })
}

/**
 * Mounts and unmounts mcp-client instances to match the user's server list,
 * and exposes the per-server connection status those instances report.
 */
export class McpManager extends TypertRemoteService {
  /** Settings and tools services this manager reads and registers against. */
  static inject = ['settings', 'tools']
  /** Empty plugin schema: the server list lives in the settings namespace. */
  static Config = z.object({})

  /** The sink every mounted mcp-client instance reads, captured once. */
  readonly sink: McpStatusSink

  /** Live mcp-client disposers by serverName; each resolves once the fiber is fully disposed. */
  private readonly disposers = new Map<string, () => Promise<void>>()
  /** Observed connection status by serverName. */
  private readonly statuses = new Map<string, McpServerStatus>()
  /** Serialized reconcile chain: an initial mount and a settings-driven one never interleave. */
  private chain: Promise<void> = Promise.resolve()
  /** The settings scope the server list is registered under, for `list` reads. */
  private readonly scope: SettingsScope<McpSettings>

  constructor(ctx: Context) {
    super(ctx, 'mcpManager', { namespace: 'mcp' })
    this.sink = {
      report: (serverName, status, detail) => {
        // 'disposed' is the manager's own teardown signal, not a connection
        // state; the manager clears the status when it disposes a server.
        if (status === 'disposed') return
        this.statuses.set(serverName, { status, detail })
        // Push the change so a configuration surface re-pulls live status
        // instead of polling; the mcp-client supervisor already contains a
        // sink failure, so a listener that throws cannot break reconnection.
        this.ctx.emit('mcp/status')
      },
    }
    ctx.provide('mcpStatusSink', this.sink)

    this.scope = ctx.settings.register<typeof MCP_SETTINGS_NAMESPACE, McpSettings>(
      MCP_SETTINGS_NAMESPACE,
      MCP_SETTINGS_SCHEMA,
      { applies: 'live', validate: validateServers },
    )
    this.scope.watch((next, prev) => {
      void this.apply(prev.servers, next.servers)
    })
    void this.apply([], this.scope.get().servers)
  }

  /** Current status for one server, or undefined while unobserved. */
  statusOf(serverName: string): McpServerStatus | undefined {
    return this.statuses.get(serverName)
  }

  /**
   * Report every server's live status and tool names for a configuration
   * surface. A server that has not reported yet answers `unknown`.
   * @returns one status view per configured server, in list order.
   */
  @Remote
  list(): McpServerStatusView[] {
    return this.scope.get().servers.map((server) => {
      const observed = this.statuses.get(server.serverName)
      return {
        serverName: server.serverName,
        status: statusKindOf(observed?.status),
        tools: this.toolsOf(server.serverName),
        ...(observed?.detail?.error === undefined ? {} : { error: observed.detail.error }),
      }
    })
  }

  /**
   * Force one server to reconnect: the manager disposes its current
   * mcp-client instance and, when the entry is still enabled, mounts a fresh
   * one that reconnects and re-discovers tools.
   * @param serverName - the entry to reconnect.
   * @returns whether the server exists and the reconnect was queued.
   */
  @Remote
  refresh(serverName: string): Promise<boolean> {
    const server = this.scope.get().servers.find(candidate => candidate.serverName === serverName)
    if (server === undefined) return Promise.resolve(false)
    const run = this.chain.then(async () => {
      await this.dispose(serverName)
      if (server.enabled) await this.mount(server)
    })
    this.chain = run.catch(() => {})
    return run.then(() => true)
  }

  /**
   * Reconcile the live mcp-client set toward `next`: disposals first, then
   * mounts. A mount that fails is contained and logged so one broken server
   * never blocks its siblings.
   * @param prev - the previously applied server list.
   * @param next - the desired server list.
   */
  apply(prev: readonly McpServerEntry[], next: readonly McpServerEntry[]): Promise<void> {
    const run = this.chain.then(async () => {
      const actions = reconcile(prev, next)
      for (const action of actions) {
        if (action.kind === 'dispose') await this.dispose(action.serverName)
      }
      for (const action of actions) {
        if (action.kind === 'mount') await this.mount(action.server)
      }
    })
    // The chain tail survives a failed reconcile; the caller owns reporting.
    this.chain = run.catch(() => {})
    return run
  }

  private async mount(server: McpServerEntry): Promise<void> {
    try {
      const config = toMcpClientConfig(server)
      const fiber = await this.ctx.plugin(McpClient, config)
      this.disposers.set(server.serverName, () => fiber.dispose())
    } catch (error) {
      // A mount that fails at load (duplicate serverName, invalid config)
      // records a failed status so a configuration surface can explain why
      // the server never came up, rather than answering `unknown` forever.
      this.statuses.set(server.serverName, { status: 'failed', detail: { error: String(error) } })
      this.ctx.logger.warn(`mcp-manager: failed to mount "${server.serverName}": ${String(error)}`)
    }
  }

  private async dispose(serverName: string): Promise<void> {
    const disposer = this.disposers.get(serverName)
    if (disposer === undefined) return
    this.disposers.delete(serverName)
    await disposer()
    this.statuses.delete(serverName)
  }

  /** The model-facing tool names one server currently registers. */
  private toolsOf(serverName: string): string[] {
    const prefix = `mcp__${serverName}__`
    return this.ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(name => name.startsWith(prefix))
  }
}
