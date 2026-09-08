/**
 * The `mcp.json` Remote surface: reading (with seed), whole-document writes
 * with validation and immediate sync, and single-server updates. Isolated file
 * so vi.mock of the MCP SDK and the filesystem doesn't pollute other suites.
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
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

// ---- Mock filesystem and watcher ----

const { fsFiles, fsAccess, fsMkdir, fsReadFile, fsWriteFile } = vi.hoisted(() => {
  const fsFiles = new Map<string, string>()
  const fsAccess = vi.fn(async (path: string) => {
    if (!fsFiles.has(path)) throw enoent(path)
  })
  const fsMkdir = vi.fn(async () => {})
  const fsReadFile = vi.fn(async (path: string) => {
    const text = fsFiles.get(path)
    if (text === undefined) throw enoent(path)
    return text
  })
  const fsWriteFile = vi.fn(async (path: string, text: string) => {
    fsFiles.set(path, text)
  })
  return { fsFiles, fsAccess, fsMkdir, fsReadFile, fsWriteFile }
})

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
}

vi.mock('node:fs/promises', () => ({
  access: fsAccess,
  mkdir: fsMkdir,
  readFile: fsReadFile,
  writeFile: fsWriteFile,
}))

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
}))

// vi.mock is hoisted above static imports, so the manager and its mcp-client
// dependency see the mocked SDK and filesystem even through a static import.
import McpManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import type { McpSettings, McpStdioServer } from '@deepseek-ai/dsh-mcp-manager'

// ---- Helpers ----

/** A file-backed provider: one in-memory document plus a fixed document path. */
class FileSettings extends SettingsProvider {
  doc: Record<string, unknown>
  private readonly path: string | undefined

  constructor(ctx: Context, config?: { path?: string; doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(config?.doc ?? {})
    this.path = config?.path
  }

  get writable(): boolean {
    return true
  }

  override get documentPath(): string | undefined {
    return this.path
  }

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** One stdio server section entry with the given name and enabled flag. */
function stdio(name: string, enabled = true): McpStdioServer {
  return { serverName: name, enabled, transport: 'stdio', command: 'echo', args: [], env: {}, cwd: '' }
}

const MCP_JSON_PATH = '/tmp/settings/mcp.json'

async function boot(doc: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(FileSettings, { path: MCP_JSON_PATH, doc })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpManager)
  return ctx
}

const signal = () => new AbortController().signal

// ---- Tests ----

describe('mcp-manager mcp.json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    instances.length = 0
    fsFiles.clear()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({
      tools: [{
        name: 'remote',
        description: 'Run a remote command',
        inputSchema: { type: 'object' },
      }],
      nextCursor: undefined,
    })
  })

  it('seeds a missing document and returns its text', async () => {
    const ctx = await boot()
    const result = await ctx.mcpManager!.readMcpDocument(signal())
    expect(result.text).toBe('{\n  "mcpServers": {}\n}\n')
    expect(fsWriteFile).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('refuses a document that is not valid JSON', async () => {
    const ctx = await boot()
    // The manager seeds the missing document on startup; settle that write
    // first so the refusal below asserts against its own write, not the seed.
    await vi.waitFor(() => { expect(fsWriteFile).toHaveBeenCalled() })
    fsWriteFile.mockClear()
    await expect(ctx.mcpManager!.writeMcpDocument('{ not json', signal()))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(fsWriteFile).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('writes a valid document and syncs it immediately', async () => {
    const ctx = await boot()
    await ctx.mcpManager!.writeMcpDocument(
      '{"mcpServers":{"srv":{"type":"stdio","command":"echo","args":[],"env":{}}}}',
      signal(),
    )
    // The immediate sync mounts the server without a watcher round-trip.
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    await ctx.fiber.dispose()
  })

  it('writes one server entry through updateMcpServer and mounts it', async () => {
    const ctx = await boot()
    await ctx.mcpManager!.updateMcpServer(stdio('srv'), signal())
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    const text = fsFiles.get(MCP_JSON_PATH)!
    expect(text).toContain('"srv"')
    await ctx.fiber.dispose()
  })

  it('mounts only the allowlisted tools when updateMcpServer carries a mask', async () => {
    const ctx = await boot()
    mockListTools.mockResolvedValue({
      tools: [
        { name: 'remote', description: 'Run a remote command', inputSchema: { type: 'object' } },
        { name: 'other', description: 'Another tool', inputSchema: { type: 'object' } },
      ],
      nextCursor: undefined,
    })

    await ctx.mcpManager!.updateMcpServer({ ...stdio('srv'), allowedTools: ['remote'] }, signal())

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(ctx.tools.get('mcp__srv__other')).toBeUndefined()
    // The mask survives the round-trip through the persisted document, so a
    // later re-read remounts the same restricted set.
    const document = JSON.parse(fsFiles.get(MCP_JSON_PATH)!) as { mcpServers: Record<string, { allowedTools?: string[] }> }
    expect(document.mcpServers['srv']?.allowedTools).toEqual(['remote'])
    await ctx.fiber.dispose()
  })

  it('reports each mounted tool with its raw name and description through list()', async () => {
    const ctx = await boot()
    await ctx.mcpManager!.updateMcpServer(stdio('srv'), signal())
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    const views = ctx.mcpManager!.list()
    const srv = views.find(view => view.serverName === 'srv')
    expect(srv?.tools).toEqual([{ name: 'remote', description: 'Run a remote command' }])
    await ctx.fiber.dispose()
  })

  it('replaces a raw non-contract key instead of leaving a duplicate', async () => {
    const ctx = await boot()
    await ctx.mcpManager!.writeMcpDocument(
      '{"mcpServers":{"我的服务器":{"type":"stdio","command":"echo","args":[],"env":{}}}}',
      signal(),
    )
    const hashed = (ctx.settings.get('mcp') as McpSettings).servers[0]!.serverName
    expect(hashed).not.toBe('我的服务器')

    await ctx.mcpManager!.updateMcpServer(stdio(hashed), signal())
    const text = fsFiles.get(MCP_JSON_PATH)!
    expect(text).toContain(hashed)
    expect(text).not.toContain('我的服务器')
    expect((ctx.settings.get('mcp') as McpSettings).servers).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('removes one server entry through removeMcpServer and unmounts it', async () => {
    const ctx = await boot()
    await ctx.mcpManager!.updateMcpServer(stdio('srv'), signal())
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    await ctx.mcpManager!.removeMcpServer('srv', signal())
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined() })
    const text = fsFiles.get(MCP_JSON_PATH)!
    expect(text).not.toContain('"srv"')
    expect((ctx.settings.get('mcp') as McpSettings).servers).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('removes a hashed raw key through removeMcpServer', async () => {
    const ctx = await boot()
    await ctx.mcpManager!.writeMcpDocument(
      '{"mcpServers":{"我的服务器":{"type":"stdio","command":"echo","args":[],"env":{}}}}',
      signal(),
    )
    const hashed = (ctx.settings.get('mcp') as McpSettings).servers[0]!.serverName

    await ctx.mcpManager!.removeMcpServer(hashed, signal())
    const text = fsFiles.get(MCP_JSON_PATH)!
    expect(text).not.toContain('我的服务器')
    expect((ctx.settings.get('mcp') as McpSettings).servers).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
