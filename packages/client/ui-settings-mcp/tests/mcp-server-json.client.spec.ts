/**
 * MCP server JSON shape helpers: pasted-config parsing (with `mcpServers`
 * unwrapping), entry↔cross-vendor conversion, and document merge/render. These
 * are pure transforms, so the specs exercise the exact bytes that reach
 * `writeMcpDocument` / `updateMcpServer`.
 */
import { describe, expect, it } from 'vitest'
import {
  entryToServerJson,
  parseDocument,
  parsePastedServers,
  parseSingleServer,
  renderDocument,
  serverJsonToEntry,
} from '../src/client/mcp-server-json.ts'
import type { McpJsonServer, McpServerEntry } from '../src/client/types.ts'

function stdio(name: string, enabled = true): McpServerEntry {
  return { serverName: name, enabled, transport: 'stdio', command: 'echo', args: [], env: {}, cwd: '' }
}

describe('parsePastedServers', () => {
  it('unwraps a top-level mcpServers wrapper and returns only its contents', () => {
    const servers = parsePastedServers('{"mcpServers":{"github":{"command":"npx","args":["-y","github"]}}}')
    expect(servers).toEqual({ github: { command: 'npx', args: ['-y', 'github'] } })
  })

  it('accepts a bare server map without a wrapper', () => {
    const servers = parsePastedServers('{"github":{"command":"npx"},"db":{"url":"http://x"}}')
    expect(Object.keys(servers)).toEqual(['github', 'db'])
  })

  it('ignores extra wrapper fields outside mcpServers', () => {
    const servers = parsePastedServers('{"mcpServers":{"a":{"command":"x"}},"other":123}')
    expect(servers).toEqual({ a: { command: 'x' } })
  })

  it('throws when the text is not valid JSON', () => {
    expect(() => parsePastedServers('{ not json')).toThrow(/not valid JSON/)
  })

  it('throws when a server value is not an object', () => {
    expect(() => parsePastedServers('{"a":"npx"}')).toThrow(/must be an object/)
  })

  it('throws when no servers are present', () => {
    expect(() => parsePastedServers('{}')).toThrow(/contains no servers/)
  })
})

describe('parseDocument', () => {
  it('returns the server map from a full mcp.json document', () => {
    expect(parseDocument('{"mcpServers":{"a":{"command":"x"}}}')).toEqual({ a: { command: 'x' } })
  })

  it('throws when the root has no mcpServers object', () => {
    expect(() => parseDocument('{"a":{"command":"x"}}')).toThrow(/mcpServers/)
  })
})

describe('parseSingleServer', () => {
  it('parses one server object', () => {
    expect(parseSingleServer('{"command":"echo"}')).toEqual({ command: 'echo' })
  })

  it('throws when the text is not an object', () => {
    expect(() => parseSingleServer('"npx"')).toThrow(/must be a JSON object/)
  })
})

describe('entryToServerJson', () => {
  it('renders a stdio entry in the cross-vendor shape', () => {
    const entry: McpServerEntry = {
      serverName: 'github', enabled: true, transport: 'stdio',
      command: 'npx', args: ['-y', 'github'], env: { GITHUB_TOKEN: 'x' }, cwd: '/tmp',
    }
    const parsed = JSON.parse(entryToServerJson(entry)) as McpJsonServer
    expect(parsed).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'github'], env: { GITHUB_TOKEN: 'x' }, cwd: '/tmp' })
  })

  it('maps enabled:false to disabled:true', () => {
    const json = JSON.parse(entryToServerJson(stdio('github', false))) as McpJsonServer
    expect(json.disabled).toBe(true)
  })

  it('omits cwd when empty and never emits serverName/transport', () => {
    const json = JSON.parse(entryToServerJson(stdio('github'))) as McpJsonServer
    expect(json).toEqual({ type: 'stdio', command: 'echo', args: [], env: {} })
  })

  it('renders the allowlist for both transports and omits it when absent', () => {
    const maskedStdio: McpServerEntry = { ...stdio('github'), allowedTools: ['search'] }
    const http: McpServerEntry = {
      serverName: 'web', enabled: true, transport: 'streamable-http', url: 'http://x', headers: {}, auth: { kind: 'none' }, allowedTools: ['ping'],
    }
    expect((JSON.parse(entryToServerJson(maskedStdio)) as McpJsonServer).allowedTools).toEqual(['search'])
    expect((JSON.parse(entryToServerJson(http)) as McpJsonServer).allowedTools).toEqual(['ping'])
    expect('allowedTools' in (JSON.parse(entryToServerJson(stdio('github'))) as McpJsonServer)).toBe(false)
  })
})

describe('serverJsonToEntry', () => {
  it('converts a stdio object back to an entry', () => {
    const entry = serverJsonToEntry('github', { command: 'npx', args: ['-y'], env: {}, disabled: true })
    expect(entry).toEqual({ serverName: 'github', enabled: false, transport: 'stdio', command: 'npx', args: ['-y'], env: {}, cwd: '' })
  })

  it('converts a url object back to an http entry', () => {
    const entry = serverJsonToEntry('web', { url: 'http://x', headers: { A: 'b' } })
    expect(entry).toEqual({ serverName: 'web', enabled: true, transport: 'streamable-http', url: 'http://x', headers: { A: 'b' }, auth: { kind: 'none' } })
  })

  it('carries the allowlist back into both transports and leaves it absent when unlisted', () => {
    const stdio = serverJsonToEntry('github', { command: 'echo', allowedTools: ['search'] })
    const http = serverJsonToEntry('web', { url: 'http://x', allowedTools: ['ping'] })
    expect(stdio).toMatchObject({ transport: 'stdio', allowedTools: ['search'] })
    expect(http).toMatchObject({ transport: 'streamable-http', allowedTools: ['ping'] })
    expect('allowedTools' in serverJsonToEntry('plain', { command: 'echo' })).toBe(false)
  })

  it('round-trips an allowlist through the edit editor shape', () => {
    const entry: McpServerEntry = { ...stdio('github'), allowedTools: ['search'] }
    const again = serverJsonToEntry('github', JSON.parse(entryToServerJson(entry)) as McpJsonServer)
    expect(again).toEqual(entry)
  })

  it('throws when neither command nor url is present', () => {
    expect(() => serverJsonToEntry('x', {})).toThrow(/command.*url/)
  })
})

describe('renderDocument', () => {
  it('wraps a server map back into mcp.json text', () => {
    expect(renderDocument({ a: { command: 'x' } })).toBe('{\n  "mcpServers": {\n    "a": {\n      "command": "x"\n    }\n  }\n}\n')
  })
})

/** One OAuth HTTP server: the shape the editor must show and preserve. */
const oauthEntry: McpServerEntry = {
  serverName: 'remote',
  enabled: true,
  transport: 'streamable-http',
  url: 'https://example.com/mcp',
  headers: {},
  auth: {
    kind: 'oauth',
    clientId: 'client-1',
    authorizationUrl: 'https://example.com/authorize',
    tokenUrl: 'https://example.com/token',
  },
}

describe('oauth in the edit round trip', () => {
  it('shows the OAuth fields so the editor can present them', () => {
    const shown = JSON.parse(entryToServerJson(oauthEntry)) as McpJsonServer
    expect(shown).toMatchObject({
      authMode: 'oauth',
      clientId: 'client-1',
      authorizationUrl: 'https://example.com/authorize',
      tokenUrl: 'https://example.com/token',
    })
  })

  it('preserves the OAuth configuration across an edit save', () => {
    // The editor is a mcp.json round trip, so an omitted field is one the user
    // cannot see and the next save would erase.
    const shown = entryToServerJson(oauthEntry)
    const back = serverJsonToEntry('remote', JSON.parse(shown))
    expect(back).toMatchObject({
      auth: {
        kind: 'oauth',
        clientId: 'client-1',
        authorizationUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
      },
    })
  })

  it('carries scopes only when the entry has them', () => {
    const withScopes: McpServerEntry = {
      ...oauthEntry,
      auth: {
        kind: 'oauth',
        clientId: 'client-1',
        authorizationUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
        scopes: ['a', 'b'],
      },
    }
    expect(JSON.parse(entryToServerJson(withScopes))).toMatchObject({ scopes: ['a', 'b'] })
    expect('scopes' in (JSON.parse(entryToServerJson(oauthEntry)) as McpJsonServer)).toBe(false)
  })

  it('writes no OAuth field for a server that uses none', () => {
    // Every entry that predates this capability renders exactly as before.
    const plain: McpServerEntry = { ...oauthEntry, serverName: 'plain', auth: { kind: 'none' } }
    const shown = JSON.parse(entryToServerJson(plain)) as McpJsonServer
    expect('authMode' in shown).toBe(false)
    expect('clientId' in shown).toBe(false)
    expect('authorizationUrl' in shown).toBe(false)
    expect('tokenUrl' in shown).toBe(false)
  })

  it('accepts pasted OAuth config when adding a server', () => {
    const pasted = JSON.stringify({
      remote: {
        url: 'https://example.com/mcp',
        authMode: 'oauth',
        clientId: 'client-1',
        authorizationUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
      },
    })
    const servers = parsePastedServers(pasted)
    expect(serverJsonToEntry('remote', servers['remote']!)).toMatchObject({
      auth: { kind: 'oauth', clientId: 'client-1' },
    })
  })
})
