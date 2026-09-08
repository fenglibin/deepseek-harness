// @vitest-environment jsdom
/** MCP section rendering: a failed connection surfaces its diagnostic error,
 * entering the section reconnects enabled servers that are not connected, the
 * per-server tool list expands to reveal each tool's name and description, the
 * add flow pastes cross-vendor config (with same-name overwrite confirmation),
 * and the edit flow opens a JSON editor seeded with one server's config. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerStatusView } from '@deepseek-ai/dsh-api-remotes/client'
import { McpSection } from '../src/client/McpSection.tsx'
import type { McpSectionProps } from '../src/client/McpSection.tsx'
import type { McpServerEntry } from '../src/client/types.ts'
import type { McpKey } from '../src/client/locales.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: (key: McpKey) => string = key => zh[key]

const server: McpServerEntry = {
  serverName: 'mysql',
  enabled: true,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'mysql-mcp-server'],
  cwd: '',
  env: {},
}

interface RenderOptions {
  documentText?: string
  documentWrite?: (text: string) => Promise<boolean>
  storeUpdate?: (entry: McpServerEntry) => Promise<boolean>
}

/** Render the section with one server whose live status is `statuses.get(serverName)`. */
function renderSection(
  statuses: Map<string, McpServerStatusView>,
  options: RenderOptions = {},
): {
  refresh: ReturnType<typeof vi.fn>
  documentWrite: ReturnType<typeof vi.fn>
  storeUpdate: ReturnType<typeof vi.fn>
} {
  const refresh = vi.fn(() => Promise.resolve())
  const documentWrite = vi.fn(options.documentWrite ?? (() => Promise.resolve(true)))
  const storeUpdate = vi.fn(options.storeUpdate ?? (() => Promise.resolve(true)))
  const props = {
    store: {
      update: storeUpdate,
      setEnabled: () => Promise.resolve(true),
      remove: () => Promise.resolve(true),
    },
    status: {
      load: () => Promise.resolve(),
      refresh,
    },
    document: {
      load: () => Promise.resolve(),
      read: () => Promise.resolve(),
      write: documentWrite,
    },
    useMcp: () => ({ available: true, writable: true, servers: [server], saving: false, failed: false }),
    useStatus: () => ({ statuses, loading: false, refreshing: false }),
    useDocument: () => ({ status: 'ready' as const, opening: false, error: null, text: options.documentText ?? '{"mcpServers":{}}' }),
    t,
  } as unknown as McpSectionProps
  render(<McpSection {...props} />)
  return { refresh, documentWrite, storeUpdate }
}

describe('McpSection connection error', () => {
  it('surfaces the diagnostic error when a server reports failed', () => {
    renderSection(new Map([['mysql', {
      serverName: 'mysql',
      status: 'failed',
      tools: [],
      error: 'command not found: npx',
    }]]))
    expect(screen.getByRole('alert').textContent).toContain('command not found: npx')
  })

  it('shows no error line for a connected server', () => {
    renderSection(new Map([['mysql', {
      serverName: 'mysql',
      status: 'connected',
      tools: [{ name: 'mcp__mysql__query', description: '' }],
    }]]))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows no error line for a failed server that reported no diagnostic', () => {
    renderSection(new Map([['mysql', {
      serverName: 'mysql',
      status: 'failed',
      tools: [],
    }]]))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('McpSection auto-connect', () => {
  it('reconnects an enabled server that is not connected', () => {
    const { refresh } = renderSection(new Map([['mysql', {
      serverName: 'mysql',
      status: 'failed',
      tools: [],
    }]]))
    expect(refresh).toHaveBeenCalledWith('mysql')
  })

  it('leaves a connected enabled server alone', () => {
    const { refresh } = renderSection(new Map([['mysql', {
      serverName: 'mysql',
      status: 'connected',
      tools: [],
    }]]))
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('McpSection tools disclosure', () => {
  it('hides the tool list by default until the toggle is clicked', () => {
    renderSection(new Map([['mysql', {
      serverName: 'mysql',
      status: 'connected',
      tools: [
        { name: 'query', description: 'Run a SQL query' },
        { name: 'list', description: 'List rows' },
      ],
    }]]))
    expect(screen.getByRole('button', { name: '2 个工具' })).toBeTruthy()
    expect(screen.queryByText('Run a SQL query')).toBeNull()
  })

  it('reveals each tool with its description and hover tooltip when expanded', () => {
    renderSection(new Map([['mysql', {
      serverName: 'mysql',
      status: 'connected',
      tools: [
        { name: 'query', description: 'Run a SQL query' },
        { name: 'list', description: 'List rows' },
      ],
    }]]))
    fireEvent.click(screen.getByRole('button', { name: '2 个工具' }))
    expect(screen.getByText('query')).toBeTruthy()
    expect(screen.getByText('list')).toBeTruthy()
    expect(screen.getByText('Run a SQL query')).toBeTruthy()
    expect(screen.getByText('List rows')).toBeTruthy()
    expect(screen.getByText('query').getAttribute('title')).toBe('Run a SQL query')
  })

  it('collapses the tool list on a second click of the toggle', () => {
    renderSection(new Map([['mysql', {
      serverName: 'mysql',
      status: 'connected',
      tools: [{ name: 'query', description: 'Run a SQL query' }],
    }]]))
    const toggle = screen.getByRole('button', { name: '1 个工具' })
    fireEvent.click(toggle)
    expect(screen.getByText('query')).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByText('query')).toBeNull()
  })

  it('disables the toggle when the server has no tools to show', () => {
    renderSection(new Map([['mysql', {
      serverName: 'mysql',
      status: 'connected',
      tools: [],
    }]]))
    const toggle = screen.getByRole('button', { name: '0 个工具' })
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('McpSection add flow', () => {
  it('opens an empty JSON editor with the add title', () => {
    renderSection(new Map())
    fireEvent.click(screen.getByRole('button', { name: '增加MCP' }))
    expect(screen.getByRole('heading', { name: '增加 MCP 服务器' })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('')
  })

  it('merges a pasted bare server map into mcp.json on save', () => {
    const { documentWrite } = renderSection(new Map(), { documentText: '{"mcpServers":{}}' })
    fireEvent.click(screen.getByRole('button', { name: '增加MCP' }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), {
      target: { value: '{"github":{"command":"npx"}}' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(documentWrite).toHaveBeenCalledTimes(1)
    const written = documentWrite.mock.calls[0]![0] as string
    expect(JSON.parse(written)).toEqual({ mcpServers: { github: { command: 'npx' } } })
  })

  it('unwraps a pasted mcpServers wrapper before merging', () => {
    const { documentWrite } = renderSection(new Map(), { documentText: '{"mcpServers":{}}' })
    fireEvent.click(screen.getByRole('button', { name: '增加MCP' }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), {
      target: { value: '{"mcpServers":{"github":{"command":"npx"}},"other":1}' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(JSON.parse(documentWrite.mock.calls[0]![0] as string)).toEqual({ mcpServers: { github: { command: 'npx' } } })
  })

  it('prompts for overwrite when a pasted name already exists', () => {
    const { documentWrite } = renderSection(new Map(), { documentText: '{"mcpServers":{"mysql":{"command":"old"}}}' })
    fireEvent.click(screen.getByRole('button', { name: '增加MCP' }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), {
      target: { value: '{"mysql":{"command":"new"}}' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('heading', { name: '覆盖已有服务器？' })).toBeTruthy()
    expect(documentWrite).not.toHaveBeenCalled()
  })

  it('overwrites the same-name server after confirmation', () => {
    const { documentWrite } = renderSection(new Map(), { documentText: '{"mcpServers":{"mysql":{"command":"old"}}}' })
    fireEvent.click(screen.getByRole('button', { name: '增加MCP' }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), {
      target: { value: '{"mysql":{"command":"new"}}' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.click(screen.getByRole('button', { name: '覆盖' }))
    expect(JSON.parse(documentWrite.mock.calls[0]![0] as string)).toEqual({ mcpServers: { mysql: { command: 'new' } } })
  })
})

describe('McpSection edit flow', () => {
  it('opens a JSON editor seeded with the server cross-vendor config', () => {
    renderSection(new Map(), { documentText: '{"mcpServers":{"mysql":{"command":"npx"}}}' })
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole('heading', { name: '编辑 mysql' })).toBeTruthy()
    const value = screen.getByRole<HTMLTextAreaElement>('textbox').value
    expect(JSON.parse(value)).toMatchObject({ type: 'stdio', command: 'npx' })
  })

  it('writes the edited server back through the single-server update', () => {
    const { storeUpdate } = renderSection(new Map(), { documentText: '{"mcpServers":{"mysql":{"command":"npx"}}}' })
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), {
      target: { value: '{"command":"other"}' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(storeUpdate).toHaveBeenCalledWith({
      serverName: 'mysql',
      enabled: true,
      transport: 'stdio',
      command: 'other',
      args: [],
      env: {},
      cwd: '',
    })
  })
})
