/**
 * Tests for the MCP OAuth pieces: the `auth` settings field, grant storage
 * through the credentials seam, and the credential resolver an mcp-client
 * instance reads. Grant storage is exercised against a real in-memory
 * `CredentialProvider`, because the property under test — that a token never
 * reaches the settings document — is only observable through the real seam.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  CredentialProvider, credentialKey, parseCredentialKey,
  type CredentialKey, type CredentialRecord, type CredentialRecordEntry, type CredentialRecordInfo,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type { ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { MCP_SETTINGS_SCHEMA, validateServers } from '@deepseek-ai/dsh-mcp-manager/src/config.ts'
import { grantIdOf, grantKeyOf, readGrant, writeGrant, deleteGrant } from '@deepseek-ai/dsh-mcp-manager/src/oauth-grant.ts'
import { createAuthSink } from '@deepseek-ai/dsh-mcp-manager/src/auth-sink.ts'
import { createOAuthFlow } from '@deepseek-ai/dsh-mcp-manager/src/oauth-flow.ts'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { McpServerEntry, McpSettings } from '@deepseek-ai/dsh-mcp-manager/src/config.ts'
import { mcpJsonToSettings, parseMcpJson, renderMcpJson, settingsToMcpJson } from '@deepseek-ai/dsh-mcp-manager/src/mcp-json.ts'

/** One in-memory credential provider: records only, no reference half. */
class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<string, CredentialRecord>()

  async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return undefined
  }

  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: false, writable: true }
  }

  async set(_ref: CredentialRef, _value: string): Promise<void> {}

  async unset(_ref: CredentialRef): Promise<void> {}

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return { configured: record !== undefined, ...(record === undefined ? {} : { kind: record.kind }), writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records.keys()].map(key => ({ key: parseCredentialKey(key), kind: 'grant' as const }))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next === undefined) return this.records.get(key)
    this.records.set(key, next)
    // The seam's record half fans this out on every committed write, and the
    // authorization seam confirms a flow's commit by observing it. A stand-in
    // that stored silently would fail every flow with NOT_COMMITTED while the
    // real provider succeeded.
    this.notifyRecordUpdated(key)
    return next
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    if (!this.records.delete(key)) return
    this.notifyRecordUpdated(key)
  }
}

/** The slice of a Node response the callback handler writes to. */
class FakeResponse {
  statusCode = 200
  body = ''
  end(body?: string): void { this.body = body ?? '' }
}

/** One HTTP server entry with OAuth auth. */
function oauthServer(name = 'remote'): McpServerEntry {
  return {
    serverName: name,
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
}

/** One HTTP server entry with no auth section at all, as older documents wrote it. */
function legacyServer(name = 'legacy'): McpServerEntry {
  return {
    serverName: name,
    enabled: true,
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    headers: {},
  } as unknown as McpServerEntry
}

describe('mcp auth settings schema', () => {
  it('resolves an omitted auth to none', () => {
    const parsed = MCP_SETTINGS_SCHEMA({ servers: [legacyServer()] })
    expect(parsed.servers[0]).toMatchObject({ auth: { kind: 'none' } })
  })

  it('accepts an oauth entry with its endpoints', () => {
    const parsed = MCP_SETTINGS_SCHEMA({ servers: [oauthServer()] })
    expect(parsed.servers[0]).toMatchObject({
      auth: {
        kind: 'oauth',
        clientId: 'client-1',
        authorizationUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
      },
    })
  })

  it('refuses a stdio entry that carries an auth section', () => {
    const stdio = {
      serverName: 'local',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
      cwd: '',
      auth: { kind: 'none' },
    } as unknown as McpServerEntry
    expect(() => { validateServers({ servers: [stdio] }) })
      .toThrow(/cannot carry an auth section/)
  })
})

describe('oauth grant storage', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // A CredentialProvider is a Cordis Service: loading it is the registration.
    await ctx.plugin(MemoryCredentials)
  })

  it('maps a server name onto a credentials-segment-safe id', () => {
    // A name already inside the credential grammar passes through verbatim, so
    // the common case stays readable in the credential store.
    expect(grantIdOf('github')).toBe('github')
    expect(grantKeyOf('github')).toBe(credentialKey('mcp-oauth', 'github'))
    // Uppercase and underscores are legal in a serverName but not in a
    // credential key segment, so those names are translated rather than
    // rejected — and the translation must accept the credential grammar.
    expect(grantIdOf('My_Server')).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('never folds two distinct server names onto one grant', () => {
    // Case folding or underscore rewriting would map `My_Server` and
    // `my-server` to the same id, letting each server overwrite the other's
    // token. Distinct names must therefore stay distinct.
    const distinct = ['My_Server', 'my-server', 'A_B', 'a-b', 'web_search', 'web-search']
    const ids = distinct.map(grantIdOf)
    expect(new Set(ids).size).toBe(distinct.length)
  })

  it('round-trips a grant without touching the settings document', async () => {
    await writeGrant(ctx, 'remote', { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 12, scopes: ['a'] })
    const grant = await readGrant(ctx, 'remote')
    expect(grant).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 12, scopes: ['a'] })
  })

  it('reads no grant for a server that never authorized', async () => {
    expect(await readGrant(ctx, 'remote')).toBeUndefined()
  })

  it('deletes a stored grant and tolerates an absent one', async () => {
    await writeGrant(ctx, 'remote', { accessToken: 'at-1' })
    await deleteGrant(ctx, 'remote')
    expect(await readGrant(ctx, 'remote')).toBeUndefined()
    await expect(deleteGrant(ctx, 'remote')).resolves.toBeUndefined()
  })
})

describe('auth sink', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemoryCredentials)
  })

  it('resolves no credential for a server that does not use oauth', async () => {
    const sink = createAuthSink(ctx, () => legacyServer())
    await expect(sink.resolve('legacy')).resolves.toBeUndefined()
  })

  it('reports unauthorized for an oauth server with no grant', async () => {
    const sink = createAuthSink(ctx, () => oauthServer())
    const resolved = await sink.resolve('remote')
    expect(resolved).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('returns a bearer header for a stored, unexpired grant', async () => {
    await writeGrant(ctx, 'remote', { accessToken: 'at-1', expiresAt: Date.now() + 600_000 })
    const sink = createAuthSink(ctx, () => oauthServer())
    await expect(sink.resolve('remote')).resolves.toEqual({ ok: true, authorization: 'Bearer at-1' })
  })

  it('reports unauthorized for an expired grant with no refresh token', async () => {
    await writeGrant(ctx, 'remote', { accessToken: 'at-1', expiresAt: Date.now() - 1_000 })
    const sink = createAuthSink(ctx, () => oauthServer())
    const resolved = await sink.resolve('remote')
    expect(resolved).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('reports unavailable when no credentials service exists', async () => {
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRuntime)
    const sink = createAuthSink(bare, () => oauthServer())
    const resolved = await sink.resolve('remote')
    expect(resolved).toMatchObject({ ok: false, reason: 'unavailable' })
  })
})

describe('oauth flow over the authorization seam', () => {
  let ctx: Context
  let routes: { path: string; handler: (req: { url?: string }, res: FakeResponse) => void }[]
  let authorized: string[]

  /** Boot the services the flow needs, plus a webserver stand-in when asked. */
  async function boot(withWebServer: boolean, port = 3080): Promise<void> {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // Order matters: AuthorizationService injects `credentials`, so the
    // provider must be mounted first for the seam to activate.
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    routes = []
    authorized = []
    if (withWebServer) {
      // A webserver stand-in: registering a route is the whole contract the
      // flow uses, so recording the handler is enough to drive the callback.
      ctx.provide('webServer', {
        port,
        register: (route: { path: string; handler: (req: { url?: string }, res: FakeResponse) => void }) => {
          routes.push(route)
          return () => {}
        },
      } as never)
    }
  }

  /** Register a flow for one OAuth server and start an attempt against it. */
  async function startFlow(serverName = 'remote', origin = 'http://127.0.0.1:3080') {
    const flow = createOAuthFlow(ctx, () => oauthServer(serverName), (name) => { authorized.push(name) })
    flow.registerFlow(serverName)
    const started = await flow.start(serverName, origin)
    return { flow, started }
  }

  beforeEach(() => { /* each test boots its own composition */ })

  it('starts an attempt and hands back the authorization URL', async () => {
    await boot(true)
    const { flow, started } = await startFlow()
    expect(started).toMatchObject({ ok: true })
    if (started.ok) {
      const url = new URL(started.url)
      // The URL carries a PKCE challenge, never the verifier.
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('code_challenge')).toBeTruthy()
      expect(started.url).not.toContain('code_verifier')
      expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3080/mcp/oauth/callback/remote')
    }
    flow.dispose()
  })

  it('builds the redirect from the origin the browser reported', async () => {
    await boot(true)
    // A GUI reached over a LAN address must redirect the human back to that
    // same address, not to a loopback literal.
    const { flow, started } = await startFlow('remote', 'http://192.168.1.5:3080')
    expect(started).toMatchObject({ ok: true })
    if (started.ok) {
      expect(new URL(started.url).searchParams.get('redirect_uri'))
        .toBe('http://192.168.1.5:3080/mcp/oauth/callback/remote')
    }
    flow.dispose()
  })

  it('refuses an origin that does not address this deployment', async () => {
    await boot(true)
    const flow = createOAuthFlow(ctx, () => oauthServer(), () => {})
    flow.registerFlow('remote')
    const elsewhere = await flow.start('remote', 'http://evil.example:9999')
    expect(elsewhere).toMatchObject({ ok: false })
    if (!elsewhere.ok) expect(elsewhere.error).toContain('does not address this deployment')
    const notAnOrigin = await flow.start('remote', 'not a url')
    expect(notAnOrigin).toMatchObject({ ok: false })
    flow.dispose()
  })

  it('refuses a non-OAuth and an unknown server', async () => {
    await boot(true)
    const flow = createOAuthFlow(ctx, name => (name === 'legacy' ? legacyServer() : undefined), () => {})
    const plain = await flow.start('legacy', 'http://127.0.0.1:3080')
    expect(plain).toMatchObject({ ok: false })
    if (!plain.ok) expect(plain.error).toContain('does not use OAuth')
    const missing = await flow.start('nope', 'http://127.0.0.1:3080')
    expect(missing).toMatchObject({ ok: false })
    if (!missing.ok) expect(missing.error).toContain('no MCP server named')
    flow.dispose()
  })

  it('refuses a server whose flow is not registered, so a disabled entry cannot be authorized', async () => {
    await boot(true)
    // The entry exists but the manager never mounted it, which is exactly the
    // disabled case: authorizing it would store a grant nothing reads.
    const flow = createOAuthFlow(ctx, () => oauthServer(), () => {})
    const unmounted = await flow.start('remote', 'http://127.0.0.1:3080')
    expect(unmounted).toMatchObject({ ok: false })
    if (!unmounted.ok) expect(unmounted.error).toContain('is disabled')
    flow.dispose()
  })

  it('still resolves a stored grant, so an authorized server keeps working', async () => {
    await boot(false)
    await writeGrant(ctx, 'remote', { accessToken: 'at-1', expiresAt: Date.now() + 600_000 })
    const sink = createAuthSink(ctx, () => oauthServer())
    await expect(sink.resolve('remote')).resolves.toEqual({ ok: true, authorization: 'Bearer at-1' })
  })

  it('exchanges the callback code, stores the grant, and asks for a reconnect', async () => {
    await boot(true)
    const tokens = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(tokens), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    try {
      const { flow, started } = await startFlow()
      expect(started).toMatchObject({ ok: true })
      if (!started.ok) return
      const state = new URL(started.url).searchParams.get('state') as string
      const route = routes.find(candidate => candidate.path.startsWith('/mcp/oauth/callback'))
      expect(route).toBeDefined()
      const res = new FakeResponse()
      route!.handler({ url: `/mcp/oauth/callback/remote?code=the-code&state=${state}` }, res)

      await vi.waitFor(() => { expect(authorized).toEqual(['remote']) })
      expect(res.statusCode).toBe(200)
      // The grant is stored through the credentials seam, not settings.
      await expect(readGrant(ctx, 'remote')).resolves.toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' })
      flow.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refuses a callback whose state was never issued', async () => {
    await boot(true)
    const { flow } = await startFlow()
    const route = routes.find(candidate => candidate.path.startsWith('/mcp/oauth/callback'))
    expect(route).toBeDefined()
    const res = new FakeResponse()
    route!.handler({ url: '/mcp/oauth/callback/remote?code=x&state=forged' }, res)
    expect(res.statusCode).toBe(400)
    expect(authorized).toEqual([])
    flow.dispose()
  })

  it('accepts one state only once, so a replayed redirect cannot reach the flow twice', async () => {
    await boot(true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'at-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    try {
      const { flow, started } = await startFlow()
      if (!started.ok) return
      const state = new URL(started.url).searchParams.get('state') as string
      const route = routes.find(candidate => candidate.path.startsWith('/mcp/oauth/callback'))
      const first = new FakeResponse()
      route!.handler({ url: `/mcp/oauth/callback/remote?code=c&state=${state}` }, first)
      await vi.waitFor(() => { expect(authorized).toEqual(['remote']) })
      const replayed = new FakeResponse()
      route!.handler({ url: `/mcp/oauth/callback/remote?code=c&state=${state}` }, replayed)
      expect(replayed.statusCode).toBe(400)
      expect(authorized).toEqual(['remote'])
      flow.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts a pasted redirect URL when no webserver can receive one', async () => {
    // Headless: the human is the transport. The seam's prompt channel is the
    // answer channel, so authorization still completes without a route.
    await boot(false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'at-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    try {
      const flow = createOAuthFlow(ctx, () => oauthServer(), (name) => { authorized.push(name) })
      flow.registerFlow('remote')
      // The settings page cannot answer prompts, so drive the seam directly
      // with an interaction that can — the same flow serves both surfaces.
      const attempt = ctx.authorization.begin({
        key: grantKeyOf('remote'),
        interaction: {
          notify: () => {},
          prompt: async () => 'http://127.0.0.1:3080/mcp/oauth/callback/remote?code=pasted-code&state=irrelevant',
        },
      })
      await expect(attempt).resolves.toEqual({ status: 'authorized' })
      await expect(readGrant(ctx, 'remote')).resolves.toMatchObject({ accessToken: 'at-1' })
      flow.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('mounts without an authorization seam and explains the refusal', async () => {
    // Headless and ACP compositions have no authorization seam: signing in has
    // no surface there, while the server's stored grant still works. The flow
    // must therefore be a no-op rather than a load failure.
    // A local composition: this test needs no authorization seam, and must not
    // disturb the one the surrounding suite boots.
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRuntime)
    await bare.plugin(MemoryCredentials)
    const flow = createOAuthFlow(bare, () => oauthServer(), () => {})
    expect(() => { flow.registerFlow('remote') }).not.toThrow()
    const started = await flow.start('remote', 'http://127.0.0.1:3080')
    expect(started).toMatchObject({ ok: false })
    if (!started.ok) expect(started.error).toContain('no authorization seam')
    // The stored grant is unaffected: the server still connects.
    await writeGrant(bare, 'remote', { accessToken: 'at-1', expiresAt: Date.now() + 600_000 })
    const sink = createAuthSink(bare, () => oauthServer())
    await expect(sink.resolve('remote')).resolves.toEqual({ ok: true, authorization: 'Bearer at-1' })
    flow.dispose()
  })

  it('keeps the previous refresh token when a refresh response omits one', async () => {
    // RFC 6749 §6 allows a refresh response without `refresh_token`, in which
    // case the old one stays valid. Losing it would force a fresh authorization
    // at the next expiry for a grant the server never revoked.
    await boot(true)
    await writeGrant(ctx, 'remote', { accessToken: 'old', refreshToken: 'rt-keep', expiresAt: Date.now() - 1000 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'new' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    try {
      const sink = createAuthSink(ctx, () => oauthServer())
      await expect(sink.resolve('remote')).resolves.toEqual({ ok: true, authorization: 'Bearer new' })
      await expect(readGrant(ctx, 'remote')).resolves.toMatchObject({
        accessToken: 'new',
        refreshToken: 'rt-keep',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('adopts a rotated refresh token when the server sends one', async () => {
    await boot(true)
    await writeGrant(ctx, 'remote', { accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() - 1000 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new',
      refresh_token: 'rt-rotated',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    try {
      const sink = createAuthSink(ctx, () => oauthServer())
      await expect(sink.resolve('remote')).resolves.toEqual({ ok: true, authorization: 'Bearer new' })
      await expect(readGrant(ctx, 'remote')).resolves.toMatchObject({
        accessToken: 'new',
        refreshToken: 'rt-rotated',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('drops a rejected refresh token so the user is asked to authorize', async () => {
    await boot(true)
    await writeGrant(ctx, 'remote', { accessToken: 'old', refreshToken: 'rt-dead', expiresAt: Date.now() - 1000 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })))
    try {
      const sink = createAuthSink(ctx, () => oauthServer())
      const resolved = await sink.resolve('remote')
      expect(resolved).toMatchObject({ ok: false, reason: 'unauthorized' })
      // Keeping a dead token would repeat the same failure on every mount and
      // hide the fact that re-authorizing is the fix.
      await expect(readGrant(ctx, 'remote')).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('unregisters a flow, so a disabled server cannot be authorized', async () => {
    await boot(true)
    const { flow } = await startFlow()
    flow.unregisterFlow('remote')
    const afterUnregister = await flow.start('remote', 'http://127.0.0.1:3080')
    expect(afterUnregister).toMatchObject({ ok: false })
    flow.dispose()
  })
})

describe('token confinement', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemoryCredentials)
  })

  it('keeps a token out of the settings document and out of mcp.json', async () => {
    const settings: McpSettings = { servers: [oauthServer()] }
    await writeGrant(ctx, 'remote', { accessToken: 'secret-access', refreshToken: 'secret-refresh' })

    // Neither the settings section nor the rendered document may carry a
    // token: the settings document is edited wholesale from a wire view, and
    // `mcp.json` is a cross-vendor file other tools read.
    const settingsText = JSON.stringify(settings)
    expect(settingsText).not.toContain('secret-access')
    expect(settingsText).not.toContain('secret-refresh')
    expect(renderMcpJson(settingsToMcpJson(settings))).not.toContain('secret')
  })

  it('keeps an OAuth server authorized across a hand-edit of mcp.json', async () => {
    // The render omits OAuth details, so a document that says nothing about
    // authentication must not be read as "no authentication": doing so would
    // erase the entry's OAuth configuration whenever the user edited any
    // other server in the file.
    const current: McpSettings = { servers: [oauthServer()] }
    const seeded = renderMcpJson(settingsToMcpJson(current))
    const handEdited = seeded.replace('"mcpServers": {', '"mcpServers": {\n    "other": { "command": "npx" },')
    const synced = mcpJsonToSettings(parseMcpJson(handEdited), current)
    expect(synced.servers.find(entry => entry.serverName === 'remote'))
      .toMatchObject({ auth: { kind: 'oauth', clientId: 'client-1' } })
  })
})
