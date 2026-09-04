/**
 * MCP server-list store: whole-list writes over the `mcp` namespace, the
 * duplicate-name refusal, and the revision fence around one write. The scope
 * runs over a scripted Remote carrier whose mutate applies the `servers` set
 * op to a mutable document, so a landed write is observable in the next read.
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import type {
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
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

/** The store over a scripted wire whose `mutate` applies the servers set op. */
async function build(initial: McpServerEntry[] = [], options?: { mutate?: () => Promise<RemoteAnswer<SettingsNamespaceView>> }) {
  let current: McpServerEntry[] = [...initial]
  const describe = vi.fn(() => Promise.resolve(ok({
    writable: true, hasDocument: false, namespaces: [view(current)],
  })))
  const mutate = vi.fn(options?.mutate ?? (async (_ns: string, ops: SettingsPathOpView[]) => {
    for (const op of ops) {
      if (op.op === 'set' && op.path.length === 1 && op.path[0] === 'servers') {
        current = op.value as unknown as McpServerEntry[]
      }
    }
    return ok(view(current))
  }))
  const wireFace = { remote: { settings: { describe, mutate } } } as never
  const mirror = new SettingsDescribeMirror(wireFace, 'host')
  const scope = new SettingsScopeController<McpSettings>(
    wireFace, { namespace: 'mcp' }, mirror, 'host', schemaService,
  )
  const store = new McpStore(scope)
  await mirror.load()
  return { store, scope, describe, mutate }
}

describe('McpStore', () => {
  it('adds a server by appending it to the list', async () => {
    const { store, mutate } = await build()
    const landed = await store.add(stdio('github'))
    expect(landed).toBe(true)
    expect(store.servers().map(server => server.serverName)).toEqual(['github'])
    expect(mutate).toHaveBeenCalledTimes(1)
    const ops = mutate.mock.calls[0]![1]
    expect(ops[0]).toMatchObject({ op: 'set', path: ['servers'] })
  })

  it('removes a server by name', async () => {
    const { store } = await build([stdio('github'), stdio('web')])
    const landed = await store.remove('github')
    expect(landed).toBe(true)
    expect(store.servers().map(server => server.serverName)).toEqual(['web'])
  })

  it('updates an existing server in place', async () => {
    const { store } = await build([stdio('github')])
    const updated: McpServerEntry = { ...stdio('github'), command: 'other' }
    const landed = await store.update(updated)
    expect(landed).toBe(true)
    expect(store.servers()[0]).toMatchObject({ serverName: 'github', command: 'other' })
  })

  it('flips the enabled flag', async () => {
    const { store } = await build([stdio('github')])
    const landed = await store.setEnabled('github', false)
    expect(landed).toBe(true)
    expect(store.servers()[0]?.enabled).toBe(false)
  })

  it('refuses to add a duplicate serverName without writing', async () => {
    const { store, mutate } = await build([stdio('github')])
    const landed = await store.add(stdio('github'))
    expect(landed).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
    expect(store.servers()).toHaveLength(1)
  })

  it('reports a failure when the Host refuses the write', async () => {
    const { store } = await build([], {
      mutate: () => Promise.resolve(fail('settings/conflict')),
    })
    const landed = await store.add(stdio('github'))
    expect(landed).toBe(false)
    expect(store.store.getSnapshot().failed).toBe(true)
  })
})
