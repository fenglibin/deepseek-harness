/**
 * MCP server-list store: every mutation — edit, toggle, and remove — writes the
 * user-editable `mcp.json` through a Host single-server update, never the `mcp`
 * settings namespace. The scope runs over a scripted Remote carrier whose
 * `describe` answers the mirror read; the Host write mocks are the only way the
 * list can change, so a store that touches the namespace would leave `mutate`
 * called and fail these specs.
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/src/client/schema.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsScopeController } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-scope.ts'
import { McpStore } from '../src/client/mcp-store.ts'
import type { McpServerEntry, McpSettings, McpStdioServer } from '../src/client/types.ts'

const schemaService = new SettingsSchemaService(new Context())

const SECTION_SCHEMA = Schema.object({
  servers: Schema.array(Schema.object({
    serverName: Schema.string(),
    enabled: Schema.boolean().default(true),
    transport: Schema.string().default('stdio'),
    command: Schema.string().default(''),
    args: Schema.array(Schema.string()).default([]),
    env: Schema.dict(Schema.string()).default({}),
    cwd: Schema.string().default(''),
    url: Schema.string().default(''),
    headers: Schema.dict(Schema.string()).default({}),
  })).default([]),
}).toJSON()

/** The settings answers over the Remote carrier, which has no envelope. */
type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteError }
function ok<T>(value: T): RemoteAnswer<T> {
  return { ok: true, value }
}
function fail(message: string): RemoteAnswer<never> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

/** One `mcp` namespace view over a server list. */
function view(servers: McpServerEntry[], revision = 3): SettingsNamespaceView {
  return {
    ns: 'mcp',
    schema: JSON.parse(JSON.stringify(SECTION_SCHEMA)) as JsonValue,
    value: { servers } as unknown as JsonValue,
    applies: 'live',
    secrets: [],
    revision,
  }
}

/** One stdio server entry with the given name and enabled flag. */
function stdio(name: string, enabled = true): McpStdioServer {
  return { serverName: name, enabled, transport: 'stdio', command: 'echo', args: [], env: {}, cwd: '' }
}

interface BuildOptions {
  updateMcpServer?: () => Promise<RemoteAnswer<{ ok: true }>>
  removeMcpServer?: () => Promise<RemoteAnswer<{ ok: true }>>
}

/** The store over a scripted wire whose `describe` answers the mirror read. */
async function build(initial: McpServerEntry[] = [], options: BuildOptions = {}) {
  const describe = vi.fn(() => Promise.resolve(ok({
    writable: true, hasDocument: false, namespaces: [view(initial)],
  })))
  const mutate = vi.fn(() => Promise.resolve(ok(view(initial))))
  const updateMcpServer = vi.fn(options.updateMcpServer ?? (() => Promise.resolve(ok({ ok: true as const }))))
  const removeMcpServer = vi.fn(options.removeMcpServer ?? (() => Promise.resolve(ok({ ok: true as const }))))
  const wireFace = { remote: { settings: { describe, mutate }, mcp: { updateMcpServer, removeMcpServer } } } as never
  const mirror = new SettingsDescribeMirror(wireFace, 'host')
  const scope = new SettingsScopeController<McpSettings>(
    wireFace, { namespace: 'mcp' }, mirror, 'host', schemaService,
  )
  const store = new McpStore(wireFace, scope)
  await mirror.load()
  return { store, scope, describe, mutate, updateMcpServer, removeMcpServer }
}

describe('McpStore', () => {
  it('removes a server through the Host mcp.json write', async () => {
    const { store, removeMcpServer, mutate } = await build([stdio('github')])
    const landed = await store.remove('github')
    expect(landed).toBe(true)
    expect(removeMcpServer).toHaveBeenCalledWith('github')
    // The removal writes `mcp.json`, not the settings namespace.
    expect(mutate).not.toHaveBeenCalled()
  })

  it('does not write when removing an absent server', async () => {
    const { store, removeMcpServer } = await build()
    const landed = await store.remove('github')
    expect(landed).toBe(true)
    expect(removeMcpServer).not.toHaveBeenCalled()
  })

  it('updates an existing server through the Host mcp.json write', async () => {
    const { store, updateMcpServer, mutate } = await build([stdio('github')])
    const updated: McpServerEntry = { ...stdio('github'), command: 'other' }
    const landed = await store.update(updated)
    expect(landed).toBe(true)
    expect(updateMcpServer).toHaveBeenCalledWith(updated)
    // The edit writes `mcp.json`, not the settings namespace.
    expect(mutate).not.toHaveBeenCalled()
  })

  it('flips the enabled flag through the Host mcp.json write', async () => {
    const { store, updateMcpServer, mutate } = await build([stdio('github')])
    const landed = await store.setEnabled('github', false)
    expect(landed).toBe(true)
    expect(updateMcpServer).toHaveBeenCalledWith({ ...stdio('github'), enabled: false })
    // The toggle writes `mcp.json`, not the settings namespace.
    expect(mutate).not.toHaveBeenCalled()
  })

  it('reports a failure when the mcp.json update is refused', async () => {
    const { store } = await build([stdio('github')], {
      updateMcpServer: () => Promise.resolve(fail('invalid')),
    })
    const landed = await store.update({ ...stdio('github'), command: 'other' })
    expect(landed).toBe(false)
    expect(store.store.getSnapshot().failed).toBe(true)
  })

  it('reports a failure when the mcp.json remove is refused', async () => {
    const { store } = await build([stdio('github')], {
      removeMcpServer: () => Promise.resolve(fail('invalid')),
    })
    const landed = await store.remove('github')
    expect(landed).toBe(false)
    expect(store.store.getSnapshot().failed).toBe(true)
  })
})
