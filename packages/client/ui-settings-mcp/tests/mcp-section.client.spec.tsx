// @vitest-environment jsdom
/** MCP section rendering: a failed connection surfaces its diagnostic error,
 * and entering the section reconnects enabled servers that are not connected. */
import { cleanup, render, screen } from '@testing-library/react'
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

/** Render the section with one server whose live status is `statuses.get(serverName)`. */
function renderSection(statuses: Map<string, McpServerStatusView>): {
  refresh: ReturnType<typeof vi.fn>
} {
  const refresh = vi.fn(() => Promise.resolve())
  const props = {
    store: {
      add: () => Promise.resolve(true),
      update: () => Promise.resolve(true),
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
      write: () => Promise.resolve(true),
    },
    useMcp: () => ({ available: true, writable: true, servers: [server], saving: false, failed: false }),
    useStatus: () => ({ statuses, loading: false, refreshing: false }),
    useDocument: () => ({ status: 'ready' as const, opening: false, error: null, text: '' }),
    t,
  } as unknown as McpSectionProps
  render(<McpSection {...props} />)
  return { refresh }
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
