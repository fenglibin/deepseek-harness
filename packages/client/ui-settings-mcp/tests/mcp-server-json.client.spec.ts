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
})

describe('serverJsonToEntry', () => {
  it('converts a stdio object back to an entry', () => {
    const entry = serverJsonToEntry('github', { command: 'npx', args: ['-y'], env: {}, disabled: true })
    expect(entry).toEqual({ serverName: 'github', enabled: false, transport: 'stdio', command: 'npx', args: ['-y'], env: {}, cwd: '' })
  })

  it('converts a url object back to an http entry', () => {
    const entry = serverJsonToEntry('web', { url: 'http://x', headers: { A: 'b' } })
    expect(entry).toEqual({ serverName: 'web', enabled: true, transport: 'streamable-http', url: 'http://x', headers: { A: 'b' } })
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
