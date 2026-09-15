/**
 * Tests for the MCP manager service: mounting enabled servers as mcp-client
 * instances, reconciling the live set on settings changes, recording reported
 * status, and refusing duplicate server names. Isolated file so vi.mock of the
 * MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

// ---- Mock MCP SDK ----

const { mockConnect, mockClose, mockListTools, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = vi.fn()
    /** SDK 1.29 的 Client 提供该方法；连接成功后生产代码会读取服务器指令。 */
    getInstructions(): string | undefined { return undefined }
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async importOriginal => ({
  // The real module supplies StreamableHTTPError, which the supervisor matches
  // to distinguish a rejected credential from any other failure.
  ...await importOriginal<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>(),
  StreamableHTTPClientTransport: vi.fn(),
}))

// vi.mock is hoisted above static imports, so the manager and its mcp-client
// dependency see the mocked SDK even through a static import.
import McpManager, { MCP_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import type { McpServerEntry, McpSettings, McpStdioServer } from '@deepseek-ai/dsh-mcp-manager'

// ---- Helpers ----

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** One stdio server section entry with the given name and enabled flag. */
function stdio(name: string, enabled = true): McpStdioServer {
  return { serverName: name, enabled, transport: 'stdio', command: 'echo', args: [], env: {}, cwd: '' }
}

/** The tool list the mock server advertises after a successful (re)connect. */
function listing(...names: string[]): { tools: { name: string; description: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, description: `Run ${name}`, inputSchema: { type: 'object' } })),
    nextCursor: undefined,
  }
}

async function boot(doc: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, { doc })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpManager)
  return ctx
}

async function replaceServers(ctx: Context, servers: McpSettings['servers']): Promise<void> {
  await ctx.settings.replace(MCP_SETTINGS_NAMESPACE, { servers })
}

// ---- Tests ----

describe('mcp-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
  })

  it('mounts enabled servers from the initial document and reports connected', async () => {
    const ctx = await boot({ [MCP_SETTINGS_NAMESPACE]: { servers: [stdio('srv')] } })

    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
      expect(ctx.mcpManager?.statusOf('srv')?.status).toBe('connected')
    })
    expect(instances).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('mounts a newly added server on a settings change', async () => {
    const ctx = await boot()
    expect(instances).toHaveLength(0)

    await replaceServers(ctx, [stdio('srv')])
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(instances).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('disposes a removed server on a settings change', async () => {
    const ctx = await boot({ [MCP_SETTINGS_NAMESPACE]: { servers: [stdio('srv')] } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    await replaceServers(ctx, [])
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined() })
    expect(ctx.mcpManager?.statusOf('srv')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('disposes a disabled server without losing its settings entry', async () => {
    const ctx = await boot({ [MCP_SETTINGS_NAMESPACE]: { servers: [stdio('srv')] } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    await replaceServers(ctx, [stdio('srv', false)])
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined() })
    // The entry stays in the document, only disabled.
    expect((ctx.settings.get(MCP_SETTINGS_NAMESPACE) as McpSettings).servers[0]?.enabled).toBe(false)
    await ctx.fiber.dispose()
  })

  it('re-mounts an enabled server whose configuration changed', async () => {
    const ctx = await boot({ [MCP_SETTINGS_NAMESPACE]: { servers: [stdio('srv')] } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    const firstCount = instances.length

    await replaceServers(ctx, [{ ...stdio('srv'), command: 'other' }])
    // The remount disposes the old instance and mounts a new one; the new
    // Client instance is the signal the remount finished, not the tool name
    // (which stays `mcp__srv__remote` across both generations).
    await vi.waitFor(() => { expect(instances.length).toBeGreaterThan(firstCount) })
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('mounts an allowlisted server and registers only its listed tools', async () => {
    mockListTools.mockResolvedValue(listing('remote', 'other'))
    const ctx = await boot({
      [MCP_SETTINGS_NAMESPACE]: { servers: [{ ...stdio('srv'), allowedTools: ['remote'] }] },
    })

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(ctx.tools.get('mcp__srv__other')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('mounts an allowlisted http server and registers only its listed tools', async () => {
    mockListTools.mockResolvedValue(listing('remote', 'other'))
    const server: McpServerEntry = {
      serverName: 'web', enabled: true, transport: 'streamable-http', url: 'http://localhost/mcp', headers: {}, auth: { kind: 'none' }, allowedTools: ['remote'],
    }
    const ctx = await boot({ [MCP_SETTINGS_NAMESPACE]: { servers: [server] } })

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__web__remote')).toBeDefined() })
    expect(ctx.tools.get('mcp__web__other')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('registers every listed tool when the entry carries no allowlist', async () => {
    mockListTools.mockResolvedValue(listing('remote', 'other'))
    const ctx = await boot({ [MCP_SETTINGS_NAMESPACE]: { servers: [stdio('srv')] } })

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__other')).toBeDefined() })
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('re-mounts a server whose allowlist changed', async () => {
    mockListTools.mockResolvedValue(listing('remote', 'other'))
    const ctx = await boot({ [MCP_SETTINGS_NAMESPACE]: { servers: [stdio('srv')] } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__other')).toBeDefined() })
    const firstCount = instances.length

    await replaceServers(ctx, [{ ...stdio('srv'), allowedTools: ['remote'] }])
    await vi.waitFor(() => {
      expect(instances.length).toBeGreaterThan(firstCount)
      expect(ctx.tools.get('mcp__srv__other')).toBeUndefined()
    })
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('reports a failed mount and spawns no client when the allowlist is empty', async () => {
    const ctx = await boot({
      [MCP_SETTINGS_NAMESPACE]: { servers: [{ ...stdio('srv'), allowedTools: [] }] },
    })

    await vi.waitFor(() => { expect(ctx.mcpManager?.statusOf('srv')?.status).toBe('failed') })
    expect(ctx.mcpManager?.statusOf('srv')?.detail?.error).toMatch(/allowedTools is empty/)
    expect(instances).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('rejects a section that reuses a serverName', async () => {
    const ctx = await boot()
    await expect(replaceServers(ctx, [stdio('dup'), stdio('dup')]))
      .rejects.toThrow(/duplicate serverName "dup"/)
    await ctx.fiber.dispose()
  })

  it('lists every server with its live status and tools', async () => {
    const ctx = await boot({ [MCP_SETTINGS_NAMESPACE]: { servers: [stdio('srv')] } })
    await vi.waitFor(() => { expect(ctx.mcpManager?.statusOf('srv')?.status).toBe('connected') })

    const views = ctx.mcpManager!.list()
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ serverName: 'srv', status: 'connected' })
    expect(views[0]!.tools).toEqual([{ name: 'remote', description: 'Run remote' }])
    await ctx.fiber.dispose()
  })

  it('refreshes a server by remounting it', async () => {
    const ctx = await boot({ [MCP_SETTINGS_NAMESPACE]: { servers: [stdio('srv')] } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    const before = instances.length

    const ok = await ctx.mcpManager!.refresh('srv')
    expect(ok).toBe(true)
    await vi.waitFor(() => { expect(instances.length).toBeGreaterThan(before) })
    await ctx.fiber.dispose()
  })

  it('mounts a stdio server carrying args and env values', async () => {
    const ctx = await boot()
    await replaceServers(ctx, [{
      serverName: 'local_mysql',
      enabled: true,
      transport: 'stdio',
      command: 'uvx',
      args: ['--from', 'mysql-mcp-server', 'mysql_mcp_server'],
      env: {
        MYSQL_HOST: '127.0.0.1',
        MYSQL_PORT: '3306',
        MYSQL_USER: 'root',
        MYSQL_PASSWORD: 'root',
        MYSQL_DATABASE: 'root',
      },
      cwd: '',
    }])
    await vi.waitFor(() => {
      expect(ctx.mcpManager?.statusOf('local_mysql')?.status).toBe('connected')
      expect(ctx.tools.get('mcp__local_mysql__remote')).toBeDefined()
    })
    await ctx.fiber.dispose()
  })
})
