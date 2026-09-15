/**
 * `mcp.json` document parsing and conversion: the cross-vendor `mcpServers`
 * map in, the manager's `servers` array out, plus the reverse render used to
 * seed a missing document.
 */
import { describe, expect, it } from 'vitest'
import {
  MCP_JSON_FILENAME,
  mcpJsonToSettings,
  parseMcpJson,
  renderMcpJson,
  settingsToMcpJson,
} from '@deepseek-ai/dsh-mcp-manager/src/mcp-json.ts'
import type { McpJson, McpSettings } from '@deepseek-ai/dsh-mcp-manager'

const STDIO = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'some-mcp-server'],
  env: { KEY: 'value' },
  cwd: '/tmp',
}

const HTTP = {
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer token' },
  transportType: 'streamable-http',
  timeout: 20000,
}

describe('parseMcpJson', () => {
  it('parses a well-formed mcpServers document', () => {
    expect(parseMcpJson(`{ "mcpServers": { "a": ${JSON.stringify(STDIO)} } }`)).toEqual({
      mcpServers: { a: STDIO },
    })
  })

  it('rejects text that is not JSON', () => {
    expect(() => parseMcpJson('not json')).toThrow(/not valid JSON/)
  })

  it('rejects a root that is not an object', () => {
    expect(() => parseMcpJson('[1, 2]')).toThrow(/root must be a JSON object/)
  })

  it('rejects a document without mcpServers', () => {
    expect(() => parseMcpJson('{}')).toThrow(/must contain a "mcpServers" object/)
  })

  it('rejects mcpServers that is not an object', () => {
    expect(() => parseMcpJson('{ "mcpServers": [] }')).toThrow(/"mcpServers" must be an object/)
  })
})

describe('mcpJsonToSettings', () => {
  it('converts a stdio server', () => {
    const settings = mcpJsonToSettings({ mcpServers: { 'my-server': STDIO } })
    expect(settings.servers).toEqual([{
      serverName: 'my-server',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
      env: { KEY: 'value' },
      cwd: '/tmp',
    }])
  })

  it('converts an http server and ignores unmanaged fields', () => {
    const settings = mcpJsonToSettings({ mcpServers: { remote: HTTP } })
    expect(settings.servers).toEqual([{
      serverName: 'remote',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      auth: { kind: 'none' },
    }])
  })

  it('maps disabled to the inverse of enabled', () => {
    const settings = mcpJsonToSettings({
      mcpServers: {
        on: { command: 'a' },
        off: { command: 'b', disabled: true },
      },
    })
    expect(settings.servers.map(server => server.enabled)).toEqual([true, false])
  })

  it('defaults args, env, cwd, and headers to empty', () => {
    const settings = mcpJsonToSettings({
      mcpServers: {
        stdio: { command: 'a' },
        http: { url: 'https://example.com' },
      },
    })
    expect(settings.servers[0]).toMatchObject({ args: [], env: {}, cwd: '' })
    expect(settings.servers[1]).toMatchObject({ headers: {} })
  })

  it('rejects a server with neither command nor url', () => {
    expect(() => mcpJsonToSettings({ mcpServers: { bad: { type: 'stdio' } } }))
      .toThrow(/needs a "command" \(stdio\) or "url" \(http\)/)
  })

  it('hashes a server name outside the namespace contract to a safe one', () => {
    const settings = mcpJsonToSettings({ mcpServers: { '中文名': { command: 'a' } } })
    const name = settings.servers[0]!.serverName
    expect(name).toMatch(/^mcp-[0-9a-f]{12}$/)
    // Deterministic: the same input maps to the same name.
    expect(mcpJsonToSettings({ mcpServers: { '中文名': { command: 'a' } } }).servers[0]!.serverName).toBe(name)
  })

  it('gives different illegal names different hashes', () => {
    const first = mcpJsonToSettings({ mcpServers: { '中文名': { command: 'a' } } }).servers[0]!.serverName
    const second = mcpJsonToSettings({ mcpServers: { '另一个名字': { command: 'b' } } }).servers[0]!.serverName
    expect(first).not.toBe(second)
  })

  it('carries an allowlist from mcp.json into both transports', () => {
    const settings = mcpJsonToSettings({
      mcpServers: {
        'my-server': { ...STDIO, allowedTools: ['search', 'read'] },
        remote: { ...HTTP, allowedTools: ['ping'] },
      },
    })
    expect(settings.servers[0]).toMatchObject({ serverName: 'my-server', allowedTools: ['search', 'read'] })
    expect(settings.servers[1]).toMatchObject({ serverName: 'remote', allowedTools: ['ping'] })
  })

  it('leaves the allowlist absent when mcp.json omits it', () => {
    const settings = mcpJsonToSettings({ mcpServers: { 'my-server': STDIO } })
    expect('allowedTools' in settings.servers[0]!).toBe(false)
  })

  it('rejects an allowlist that is not an array of strings', () => {
    const bad = { mcpServers: { a: { command: 'x', allowedTools: 'search' } } } as unknown as McpJson
    const nested = { mcpServers: { a: { command: 'x', allowedTools: [1] } } } as unknown as McpJson
    expect(() => mcpJsonToSettings(bad)).toThrow(/allowedTools must be an array of strings/)
    expect(() => mcpJsonToSettings(nested)).toThrow(/allowedTools must be an array of strings/)
  })

  it('rejects a non-string args or env field', () => {
    const badArgs = { mcpServers: { a: { command: 'x', args: [1] } } } as unknown as McpJson
    const badEnv = { mcpServers: { a: { command: 'x', env: { K: 1 } } } } as unknown as McpJson
    expect(() => mcpJsonToSettings(badArgs)).toThrow(/args must be an array of strings/)
    expect(() => mcpJsonToSettings(badEnv)).toThrow(/env must be an object of string values/)
  })
})

describe('settingsToMcpJson and renderMcpJson', () => {
  it('round-trips the manager section through mcp.json', () => {
    const settings: McpSettings = {
      servers: [
        { serverName: 'a', enabled: true, transport: 'stdio', command: 'npx', args: ['-y'], env: {}, cwd: '' },
        { serverName: 'b', enabled: false, transport: 'streamable-http', url: 'https://example.com', headers: { A: 'b' }, auth: { kind: 'none' } },
      ],
    }
    const json = settingsToMcpJson(settings)
    expect(json.mcpServers['a']).toEqual({ type: 'stdio', command: 'npx', args: ['-y'], env: {} })
    expect(json.mcpServers['b']).toEqual({ url: 'https://example.com', headers: { A: 'b' }, disabled: true })
    // A full round-trip preserves every managed field.
    expect(mcpJsonToSettings(parseMcpJson(renderMcpJson(json)))).toEqual(settings)
  })

  it('round-trips an allowlist through the document', () => {
    const settings: McpSettings = {
      servers: [
        { serverName: 'a', enabled: true, transport: 'stdio', command: 'npx', args: [], env: {}, cwd: '', allowedTools: ['search'] },
        { serverName: 'b', enabled: true, transport: 'streamable-http', url: 'https://example.com', headers: {}, auth: { kind: 'none' } },
      ],
    }
    const json = settingsToMcpJson(settings)
    expect(json.mcpServers['a']).toMatchObject({ allowedTools: ['search'] })
    expect('allowedTools' in json.mcpServers['b']!).toBe(false)
    expect(mcpJsonToSettings(parseMcpJson(renderMcpJson(json)))).toEqual(settings)
  })

  it('renders pretty JSON with a trailing newline', () => {
    const text = renderMcpJson({ mcpServers: { a: { command: 'npx' } } })
    expect(text).toContain('"mcpServers"')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({ mcpServers: { a: { command: 'npx' } } })
  })
})

describe('MCP_JSON_FILENAME', () => {
  it('names the document mcp.json', () => {
    expect(MCP_JSON_FILENAME).toBe('mcp.json')
  })
})

describe('mcp.json auth handling', () => {
  it('recognizes an oauth entry and keeps its endpoints', () => {
    const settings = mcpJsonToSettings({
      mcpServers: {
        remote: {
          url: 'https://example.com/mcp',
          authMode: 'oauth',
          clientId: 'client-1',
          authorizationUrl: 'https://example.com/authorize',
          tokenUrl: 'https://example.com/token',
        },
      },
    })
    expect(settings.servers[0]).toMatchObject({
      auth: {
        kind: 'oauth',
        clientId: 'client-1',
        authorizationUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
      },
    })
  })

  it('refuses an entry that names oauth without its endpoints', () => {
    // One-way recognition: the cross-vendor document may name OAuth with a
    // vendor's own conventions. Rather than degrade silently to `none`, the
    // sync names what is missing so the document can be fixed.
    expect(() => mcpJsonToSettings({
      mcpServers: { remote: { url: 'https://example.com/mcp', authMode: 'oauth' } },
    })).toThrow(/missing clientId, authorizationUrl, or tokenUrl/)
  })

  it('renders oauth details so a settings-page edit cannot erase them', () => {
    // The settings editor is a mcp.json round trip: a field the render omits is
    // a field the editor cannot show, and the save that follows writes the
    // entry back without it.
    const json = settingsToMcpJson({
      servers: [{
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
      }],
    })
    expect(json.mcpServers['remote']).toMatchObject({
      authMode: 'oauth',
      clientId: 'client-1',
      authorizationUrl: 'https://example.com/authorize',
      tokenUrl: 'https://example.com/token',
    })
  })

  it('round-trips an oauth entry through the document unchanged', () => {
    const settings: McpSettings = {
      servers: [{
        serverName: 'remote',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { 'X-Extra': 'v' },
        auth: {
          kind: 'oauth',
          clientId: 'client-1',
          authorizationUrl: 'https://example.com/authorize',
          tokenUrl: 'https://example.com/token',
          scopes: ['a', 'b'],
        },
      }],
    }
    const back = mcpJsonToSettings(parseMcpJson(renderMcpJson(settingsToMcpJson(settings))))
    expect(back.servers[0]).toMatchObject({
      serverName: 'remote',
      url: 'https://example.com/mcp',
      headers: { 'X-Extra': 'v' },
      auth: {
        kind: 'oauth',
        clientId: 'client-1',
        authorizationUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
        scopes: ['a', 'b'],
      },
    })
  })

  it('writes no oauth field for an entry that uses none', () => {
    // Every entry that predates this capability renders exactly as before.
    const json = settingsToMcpJson({
      servers: [{
        serverName: 'plain',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {},
        auth: { kind: 'none' },
      }],
    })
    const entry = json.mcpServers['plain']!
    expect('authMode' in entry).toBe(false)
    expect('clientId' in entry).toBe(false)
    expect('authorizationUrl' in entry).toBe(false)
    expect('tokenUrl' in entry).toBe(false)
    expect('scopes' in entry).toBe(false)
  })
})
