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
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Side-effect type imports: declaration-merge `ctx.settings` and `ctx.tools`.
import type {} from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import { watch as chokidarWatch } from 'chokidar'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpServerEntry } from './config.ts'
import { MCP_SETTINGS_NAMESPACE, MCP_SETTINGS_SCHEMA, validateServers } from './config.ts'
import type { McpSettings } from './config.ts'
import { MCP_JSON_FILENAME, mcpJsonToSettings, parseMcpJson, renderMcpJson, sanitizeServerName, settingsToMcpJson } from './mcp-json.ts'
import type { McpJson } from './mcp-json.ts'
import { reconcile } from './reconcile.ts'
import type { McpDocumentTextValue, McpDocumentWriteValue, McpServerStatusKind, McpServerStatusView, McpToolInfo } from './status.ts'

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

/**
 * Convert one settings entry into the mcp-client config the bridge validates.
 * The settings document returns a frozen snapshot, and Schemastery's dict and
 * array resolvers mutate their input while normalizing. The `args`, `env`, and
 * `headers` collections are therefore shallow-copied so the config parse never
 * writes through a frozen reference and fails the union. `allowedTools` is
 * copied for the same reason and stays absent when the entry omits it, so an
 * unmasked server keeps admitting every tool the server lists.
 */
function toMcpClientConfig(server: McpServerEntry): McpClient.Config {
  const allowed = server.allowedTools === undefined ? {} : { allowedTools: [...server.allowedTools] }
  if (server.transport === 'stdio') {
    return McpClient.Config({
      transport: 'stdio',
      serverName: server.serverName,
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
      cwd: server.cwd,
      ...allowed,
    })
  }
  return McpClient.Config({
    transport: 'streamable-http',
    serverName: server.serverName,
    url: server.url,
    headers: { ...server.headers },
    ...allowed,
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
  /** Absolute path of the user-editable `mcp.json`, or undefined without a file settings provider. */
  private readonly mcpJsonPath: string | undefined

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

    // The user-editable `mcp.json` lives beside the settings document and
    // syncs one-way into the `mcp` namespace. Without a file settings provider
    // there is nowhere to put it, so the sync and open gestures stay off.
    this.mcpJsonPath = mcpJsonPathOf(ctx.settings)
    if (this.mcpJsonPath !== undefined) {
      this.installMcpJsonSync()
    }
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
  private toolsOf(serverName: string): McpToolInfo[] {
    const prefix = `mcp__${serverName}__`
    return this.ctx.tools.schemas()
      .filter(schema => schema.name.startsWith(prefix))
      .map(schema => ({
        name: schema.name.slice(prefix.length),
        description: schema.description,
      }))
  }

  /**
   * Read the current `mcp.json` text for in-place editing. A missing document
   * is seeded first, so the editor always starts from what settings holds.
   * @param signal - caller lifetime; abort terminates the read.
   * @returns the raw document text.
   * @throws RemoteError when no local document exists or the read fails.
   */
  @Remote
  async readMcpDocument(signal: AbortSignal): Promise<McpDocumentTextValue> {
    const path = this.mcpJsonPath
    if (path === undefined) {
      throw new RemoteError('gateway/internal', 'this deployment has no local MCP document', {})
    }
    await this.bootstrapMcpJson()
    if (signal.aborted) throw new RemoteError('gateway/cancelled', 'mcp.json read was aborted', {})
    try {
      const text = await readFile(path, 'utf8')
      return { text }
    } catch (error) {
      if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'mcp.json read was aborted', {})
      throw new RemoteError('gateway/internal', `mcp.json read failed: ${messageOf(error)}`, {}, { cause: error })
    }
  }

  /**
   * Validate, persist, and immediately sync a whole `mcp.json` document. The
   * text is parsed and converted before any write, so a malformed or invalid
   * document is refused with its diagnostic and never reaches settings. A valid
   * write is synced synchronously (not left to the file watcher) so the change
   * takes effect immediately.
   * @param text - the candidate `mcp.json` text.
   * @param signal - caller lifetime; abort terminates the write.
   * @returns confirmation after the document is persisted and synced.
   * @throws RemoteError when no local document exists, the text is invalid, or the write fails.
   */
  @Remote
  async writeMcpDocument(text: string, signal: AbortSignal): Promise<McpDocumentWriteValue> {
    const path = this.mcpJsonPath
    if (path === undefined) {
      throw new RemoteError('gateway/internal', 'this deployment has no local MCP document', {})
    }
    // Validate before any write: a malformed document is refused in place.
    try {
      mcpJsonToSettings(parseMcpJson(text))
    } catch (error) {
      throw new RemoteError('gateway/bad-request', `mcp.json is invalid: ${messageOf(error)}`, {})
    }
    if (signal.aborted) throw new RemoteError('gateway/cancelled', 'mcp.json write was aborted', {})
    try {
      await writeFile(path, text, { mode: 0o600 })
    } catch (error) {
      if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'mcp.json write was aborted', {})
      throw new RemoteError('gateway/internal', `mcp.json write failed: ${messageOf(error)}`, {}, { cause: error })
    }
    // Sync immediately so the change applies now, not on the watcher's debounce.
    await this.syncMcpJson()
    return { ok: true }
  }

  /**
   * Write one server's entry back into `mcp.json` and immediately sync it. The
   * entry is converted to the cross-vendor `mcpServers` shape and merged over
   * the existing document, so fields outside the edited server are preserved.
   * @param server - the entry to write, keyed by its `serverName`.
   * @param signal - caller lifetime; abort terminates the write.
   * @returns confirmation after the document is persisted and synced.
   * @throws RemoteError when no local document exists or the write fails.
   */
  @Remote
  async updateMcpServer(server: McpServerEntry, signal: AbortSignal): Promise<McpDocumentWriteValue> {
    const path = this.mcpJsonPath
    if (path === undefined) {
      throw new RemoteError('gateway/internal', 'this deployment has no local MCP document', {})
    }
    let document: McpJson
    try {
      const text = await this.readMcpDocument(signal)
      document = parseMcpJson(text.text)
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', `mcp.json read failed: ${messageOf(error)}`, {}, { cause: error })
    }
    const converted = settingsToMcpJson({ servers: [server] })
    const entry = converted.mcpServers[server.serverName]
    if (entry === undefined) {
      throw new RemoteError('gateway/bad-request', `cannot render server "${server.serverName}"`, {})
    }
    // Rebuild the map so a raw key the sync hashed into `server.serverName` (a
    // non-contract name like CJK) is replaced rather than left beside the new
    // one — a leftover would read back as a duplicate serverName and refuse the
    // whole sync.
    const mcpServers: McpJson['mcpServers'] = {}
    for (const [rawName, raw] of Object.entries(document.mcpServers)) {
      if (rawName !== server.serverName && sanitizeServerName(rawName) === server.serverName) continue
      mcpServers[rawName] = raw
    }
    mcpServers[server.serverName] = entry
    document.mcpServers = mcpServers
    return this.writeMcpDocument(renderMcpJson(document), signal)
  }

  /**
   * Remove one server's entry from `mcp.json` and immediately sync it. Any raw
   * key that hashes into `serverName` is dropped, so a non-contract name the
   * sync hashed still removes cleanly; an absent name writes the unchanged
   * document. Fields outside the removed server are preserved.
   * @param serverName - the entry to remove.
   * @param signal - caller lifetime; abort terminates the write.
   * @returns confirmation after the document is persisted and synced.
   * @throws RemoteError when no local document exists or the write fails.
   */
  @Remote
  async removeMcpServer(serverName: string, signal: AbortSignal): Promise<McpDocumentWriteValue> {
    const path = this.mcpJsonPath
    if (path === undefined) {
      throw new RemoteError('gateway/internal', 'this deployment has no local MCP document', {})
    }
    let document: McpJson
    try {
      const text = await this.readMcpDocument(signal)
      document = parseMcpJson(text.text)
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', `mcp.json read failed: ${messageOf(error)}`, {}, { cause: error })
    }
    const mcpServers: McpJson['mcpServers'] = {}
    for (const [rawName, raw] of Object.entries(document.mcpServers)) {
      if (sanitizeServerName(rawName) === serverName) continue
      mcpServers[rawName] = raw
    }
    document.mcpServers = mcpServers
    return this.writeMcpDocument(renderMcpJson(document), signal)
  }

  /** Seed a missing `mcp.json` from the current settings section, then watch it. */
  private installMcpJsonSync(): void {
    const path = this.mcpJsonPath as string
    this.ctx.effect(() => {
      let watcher: ReturnType<typeof chokidarWatch> | undefined
      let closed = false
      // Seed before watching so the seed write cannot self-trigger a sync; the
      // watcher starts only after that settles.
      void this.bootstrapMcpJson().then(() => {
        if (closed) return
        watcher = chokidarWatch(path, {
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 10 },
        })
        watcher.on('all', () => { void this.syncMcpJson() })
        watcher.on('error', (error: unknown) => {
          this.ctx.logger.warn('mcp-manager: watcher error on %s', path)
          this.ctx.logger.warn(error)
        })
      })
      return () => {
        closed = true
        void watcher?.close()
      }
    }, 'mcp-manager: mcp.json sync')
  }

  /** Create `mcp.json` from the current settings section when it does not exist. */
  private async bootstrapMcpJson(): Promise<void> {
    const path = this.mcpJsonPath
    if (path === undefined) return
    try {
      await access(path)
      return
    } catch (error) {
      if (!isENOENT(error)) {
        this.ctx.logger.warn('mcp-manager: cannot read %s: %s', path, messageOf(error))
        return
      }
    }
    try {
      const text = renderMcpJson(settingsToMcpJson(this.scope.get()))
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, text, { mode: 0o600 })
    } catch (error) {
      this.ctx.logger.warn('mcp-manager: cannot create %s: %s', path, messageOf(error))
    }
  }

  /** Parse a changed `mcp.json` and overwrite the settings section it maps to. */
  private async syncMcpJson(): Promise<void> {
    const path = this.mcpJsonPath
    if (path === undefined) return
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return
      this.ctx.logger.warn('mcp-manager: cannot read %s: %s', path, messageOf(error))
      return
    }
    let settings: McpSettings
    try {
      settings = mcpJsonToSettings(parseMcpJson(text))
    } catch (error) {
      // A malformed or invalid document must never reach settings; leave it
      // for the user to fix and keep the last good section in place.
      this.ctx.logger.warn('mcp-manager: skipped %s sync: %s', path, messageOf(error))
      return
    }
    try {
      await this.scope.replace({ servers: settings.servers })
    } catch (error) {
      this.ctx.logger.warn('mcp-manager: failed to sync %s into settings: %s', path, messageOf(error))
    }
  }
}

/** Whether the caller's signal has already aborted. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Whether a filesystem error means the path is absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Human message for any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the `mcp.json` path beside the settings document, when there is one. */
function mcpJsonPathOf(settings: { documentPath: string | undefined }): string | undefined {
  const documentPath = settings.documentPath
  if (documentPath === undefined) return undefined
  return join(dirname(documentPath), MCP_JSON_FILENAME)
}
