/**
 * Tests for the connection supervisor's optional status sink: the
 * connecting → connected → reconnecting → failed → disposed transitions a
 * management surface observes, that every report carries its `serverName`, that
 * a throwing sink cannot disturb the supervisor, and that a deployment with no
 * sink behaves exactly as before. Isolated file so vi.mock of the MCP SDK
 * doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type {
  Config, McpConnectionStatus, McpStatusDetail, McpStatusSink,
} from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
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

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { resolveReconnectPolicy, startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'

// ---- Helpers ----

/** Diagnostic prefix the tests pass to {@link resolveReconnectPolicy}. */
const POLICY_PATH = 'mcp-client(srv): reconnect'

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Capture the supervisor's logger lines by level on one context. */
function captureLogs(ctx: Context): { warns: string[]; errors: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  return { warns, errors }
}

function stdioConfig(reconnect?: Config['reconnect']): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...reconnect === undefined ? {} : { reconnect },
  }
}

/** The tool list the mock server advertises after a successful (re)connect. */
function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    nextCursor: undefined,
  }
}

/** One report as a sink recorded it. */
interface RecordedReport {
  readonly serverName: string
  readonly status: McpConnectionStatus
  readonly detail: McpStatusDetail | undefined
}

/** Attach a sink that records every report for assertion. */
function recordingSink(): { sink: McpStatusSink; reports: RecordedReport[] } {
  const reports: RecordedReport[] = []
  const sink: McpStatusSink = {
    report: (serverName, status, detail) => {
      reports.push({ serverName, status, detail })
    },
  }
  return { sink, reports }
}

// ---- Tests ----

describe('connection status sink', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
    ctx = await mountRegistry()
  })

  it('reports connecting then connected on a successful startup', async () => {
    const { sink, reports } = recordingSink()
    const handle = startConnection(ctx, stdioConfig(), resolveReconnectPolicy(undefined, POLICY_PATH), sink)
    await handle.ready
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    expect(reports.map(entry => entry.status)).toEqual(['connecting', 'connected'])
    expect(reports.every(entry => entry.serverName === 'srv')).toBe(true)
    await handle.dispose()
  })

  it('reports reconnecting with attempt accounting, then connected after recovery', async () => {
    const { sink, reports } = recordingSink()
    ctx.provide('mcpStatusSink', sink)
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    // One 'reconnecting' per outage: the scheduler emits it with the attempt
    // accounting, and the reconnect attempt does not repeat it.
    expect(reports.map(entry => entry.status)).toEqual([
      'connecting', 'connected', 'reconnecting', 'connected',
    ])
    expect(reports[2]!.detail).toEqual({ attempt: 1, maxAttempts: 5 })
  })

  it('reports failed with attempt accounting when the budget is exhausted', async () => {
    const { sink, reports } = recordingSink()
    ctx.provide('mcpStatusSink', sink)
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 2 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    mockConnect.mockRejectedValue(new Error('server gone'))
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(reports.some(entry => entry.status === 'failed')).toBe(true) })
    const failure = reports.at(-1)!
    expect(failure.status).toBe('failed')
    expect(failure.detail?.attempt).toBe(2)
    expect(failure.detail?.maxAttempts).toBe(2)
    expect(failure.detail?.error).toContain('giving up after 2')
  })

  it('reports failed when reconnect is disabled', async () => {
    const { sink, reports } = recordingSink()
    ctx.provide('mcpStatusSink', sink)
    await apply(ctx, stdioConfig({ enabled: false }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(reports.some(entry => entry.status === 'failed')).toBe(true) })
    expect(reports.at(-1)!.detail?.error).toContain('connection lost and reconnect is disabled')
  })

  it('reports disposed once teardown completes', async () => {
    const { sink, reports } = recordingSink()
    const handle = startConnection(ctx, stdioConfig(), resolveReconnectPolicy(undefined, POLICY_PATH), sink)
    await handle.ready
    await handle.dispose()

    expect(reports.at(-1)!.status).toBe('disposed')
  })

  it('contains a throwing sink and keeps supervising', async () => {
    const { warns } = captureLogs(ctx)
    const sink: McpStatusSink = {
      report: () => { throw new Error('sink exploded') },
    }
    const handle = startConnection(ctx, stdioConfig(), resolveReconnectPolicy(undefined, POLICY_PATH), sink)
    await handle.ready
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    // Every report threw, yet the supervisor completed discovery and logged
    // each contained failure instead of breaking the reconnect loop.
    expect(warns.filter(line => line.includes('status sink failed while reporting')).length).toBeGreaterThan(0)
    await handle.dispose()
  })

  it('registers tools normally when no sink is attached', async () => {
    await apply(ctx, stdioConfig())
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(ctx.get('mcpStatusSink')).toBeUndefined()
  })
})
