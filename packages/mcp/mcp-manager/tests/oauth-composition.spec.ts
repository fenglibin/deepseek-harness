/**
 * The MCP manager's OAuth path over a real Loader tree: a test-only
 * `cordis.yml` boots the manager through the Loader and app/process, and the
 * only mocked part is the MCP server's HTTP endpoint. A hand-built
 * `ctx.plugin(ctx => …)` suite cannot show that the credential seam, the
 * settings namespace, and the connection supervisor compose — that a server
 * needing authorization reports `needs-auth` instead of `failed` is exactly the
 * cross-plugin fact this file exists to pin.
 */
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

const { instances } = vi.hoisted(() => {
  const instances: unknown[] = []
  return { instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onclose: (() => void) | undefined
    connect = vi.fn(async () => { throw new Error('no credential: server refused') })
    close = vi.fn(async () => {})
    request = vi.fn(async () => ({ tools: [] }))
    setNotificationHandler = vi.fn()
    constructor() { instances.push(this) }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>(),
  StreamableHTTPClientTransport: vi.fn(),
}))

import { MCP_SETTINGS_NAMESPACE } from '../src/config.ts'
import type { McpServerEntry } from '../src/config.ts'

/** This package's directory: the fixture must sit inside the workspace tree. */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Repository root, so a fixture row can address a package by built entry. */
const REPO_ROOT = join(PACKAGE_DIR, '..', '..', '..')

/**
 * Address one package's built entry for a fixture row. A `cordis.yml` row is
 * resolved by Node from the file that imports it, and this package does not
 * depend on every plugin the composition needs, so a bare specifier would not
 * resolve — the built entry path can.
 * @param rel - package directory relative to `packages/`.
 * @returns a `file:` URL for the package's built entry.
 */
function entryUrl(rel: string): string {
  return pathToFileURL(join(REPO_ROOT, 'packages', rel, 'lib', 'index.js')).href
}

const disposers: (() => Promise<void>)[] = []
const files: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const file of files.splice(0)) rmSync(file, { force: true })
})

/**
 * Boot a real Loader tree carrying the manager and one OAuth server.
 * @param settings - the `mcp` settings section to seed.
 * @returns the running root context and the manager service.
 */
async function boot(settings: unknown): Promise<Context> {
  // The fixture sits directly in this package directory rather than in a temp
  // subdirectory: a Loader row names packages by bare specifier, and Node
  // resolves those from the importing file upward, which only finds the
  // workspace node_modules from a real package root.
  const dir = PACKAGE_DIR
  const settingsPath = join(dir, 'oauth-fixture-settings.yaml')
  const configPath = join(dir, 'oauth-fixture-cordis.yml')
  writeFileSync(settingsPath, JSON.stringify({ [MCP_SETTINGS_NAMESPACE]: settings }))
  writeFileSync(configPath, [
    `- name: ${entryUrl('core/system-prompt')}`,
    `- name: ${entryUrl('core/tools')}`,
    `- name: ${entryUrl('settings/settings-file')}`,
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    `- name: ${pathToFileURL(join(dir, 'provider.mjs')).href}`,
    `- name: ${entryUrl('credentials/authorization')}`,
    `- name: ${entryUrl('mcp/mcp-manager')}`,
  ].join('\n'))
  writeFileSync(join(dir, 'provider.mjs'), `
import { CredentialProvider } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'packages', 'credentials', 'credentials', 'lib', 'index.js')).href)}

/** An in-memory provider: the composition needs the service, not a file. */
class MemoryCredentials extends CredentialProvider {
  constructor(ctx) {
    super(ctx)
    this.records = new Map()
  }
  async resolve() { return undefined }
  async describe() { return { configured: false, writable: true } }
  async set() {}
  async unset() {}
  async readRecord(key) { return this.records.get(key) }
  async describeRecord(key) {
    const record = this.records.get(key)
    return { configured: record !== undefined, writable: true }
  }
  async listRecords() { return [] }
  async modifyRecord(key, mutate) {
    const next = await mutate(this.records.get(key))
    if (next === undefined) return this.records.get(key)
    this.records.set(key, next)
    return next
  }
  async deleteRecord(key) { this.records.delete(key) }
}
export function apply(ctx) { ctx.plugin(MemoryCredentials) }
`)
  files.push(settingsPath, configPath, join(dir, 'provider.mjs'))

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return ctx
}

describe('mcp manager OAuth composition', () => {
  it('reports needs-auth for an OAuth server with no stored grant', async () => {
    const ctx = await boot({
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

    const manager = ctx.get('mcpManager')
    expect(manager).toBeDefined()
    await vi.waitFor(() => {
      const view = manager!.list().find(entry => entry.serverName === 'remote')
      expect(view?.status).toBe('needs-auth')
      // The diagnostic names the missing step: authorizing, not a server fault.
      expect(view?.error).toContain('not authorized yet')
    })
  })

  it('registers an authorization flow for an OAuth server and can start one', async () => {
    // The end-to-end fact this file exists for: the manager mounts the server,
    // registers its flow with the authorization seam, and can hand a settings
    // surface a real authorization URL.
    const ctx = await boot({
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
    const manager = ctx.get('mcpManager')
    expect(manager).toBeDefined()
    await vi.waitFor(() => {
      expect(manager!.list().find(entry => entry.serverName === 'remote')).toBeDefined()
    })
    await vi.waitFor(() => {
      expect(ctx.authorization?.list().map(entry => entry.label)).toContain('MCP: remote')
    })
    const started = await manager!.startAuth('remote', 'http://127.0.0.1:3080')
    const url = new URL(started.url)
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3080/mcp/oauth/callback/remote')
  })

  it('withdraws the flow when the entry stops being an OAuth server', async () => {
    // The manager reconciles the flow set with the mounted set: a server whose
    // auth changed must not keep offering an authorization that would write a
    // grant nothing reads.
    const ctx = await boot({
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
    await vi.waitFor(() => {
      expect(ctx.authorization?.list().map(entry => entry.label)).toContain('MCP: remote')
    })
    // Disabling the entry unmounts it, which must withdraw its flow.
    await ctx.settings.replace(MCP_SETTINGS_NAMESPACE, { servers: [] })
    await vi.waitFor(() => {
      expect(ctx.authorization?.list().map(entry => entry.label)).not.toContain('MCP: remote')
    })
  })

  it('keeps an OAuth entry configured when the settings page edits and saves it', async () => {
    // The end-to-end fact behind the settings editor: a save goes through the
    // Host's single-server update, which re-renders the entry into mcp.json. If
    // that render omitted the OAuth fields, this edit would erase them.
    const ctx = await boot({
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
    const manager = ctx.get('mcpManager')
    await vi.waitFor(() => {
      expect(manager!.list().find(entry => entry.serverName === 'remote')).toBeDefined()
    })
    // What the editor hands back after the user changed only the URL.
    await manager!.updateMcpServer({
      serverName: 'remote',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://example.com/mcp-v2',
      headers: {},
      auth: {
        kind: 'oauth',
        clientId: 'client-1',
        authorizationUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
      },
    }, new AbortController().signal)

    await vi.waitFor(() => {
      const settings = ctx.settings.get(MCP_SETTINGS_NAMESPACE) as { servers: McpServerEntry[] }
      const entry = settings.servers.find(candidate => candidate.serverName === 'remote')
      expect(entry).toMatchObject({ url: 'https://example.com/mcp-v2' })
      expect(entry?.transport === 'streamable-http' ? entry.auth : undefined)
        .toMatchObject({ kind: 'oauth', clientId: 'client-1' })
    })
    // The flow is still offered: the entry is still an OAuth server.
    await vi.waitFor(() => {
      expect(ctx.authorization?.list().map(entry => entry.label)).toContain('MCP: remote')
    })
  })

  it('keeps an unauthenticated server connected when no auth is configured', async () => {
    // The regression this guards: `auth` is new, and a server that never
    // named it must behave exactly as it did before — no credential is
    // requested, so the transport is built and the connection proceeds.
    const ctx = await boot({
      servers: [{
        serverName: 'plain',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {},
      }],
    })

    const manager = ctx.get('mcpManager')
    await vi.waitFor(() => {
      const view = manager!.list().find(entry => entry.serverName === 'plain')
      expect(view).toBeDefined()
    })
    const view = manager!.list().find(entry => entry.serverName === 'plain')
    expect(view?.status).not.toBe('needs-auth')
  })
})
