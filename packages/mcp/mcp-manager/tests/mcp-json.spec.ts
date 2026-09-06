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
        { serverName: 'b', enabled: false, transport: 'streamable-http', url: 'https://example.com', headers: { A: 'b' } },
      ],
    }
    const json = settingsToMcpJson(settings)
    expect(json.mcpServers['a']).toEqual({ type: 'stdio', command: 'npx', args: ['-y'], env: {} })
    expect(json.mcpServers['b']).toEqual({ url: 'https://example.com', headers: { A: 'b' }, disabled: true })
    // A full round-trip preserves every managed field.
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
