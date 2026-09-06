/**
 * MCP settings section registration: the `settings.section` entry, its
 * locale-following label, and the three injected stores (server list, live
 * status, configure document) all come from one apply.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, scriptedSettingsRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-mcp/client'
import { McpSection } from '../src/client/McpSection.tsx'
import type { McpSectionInjected } from '../src/client/McpSection.tsx'
import { McpStore } from '../src/client/mcp-store.ts'
import { McpStatusStore } from '../src/client/mcp-status-store.ts'
import { McpDocumentStore } from '../src/client/mcp-document-store.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const remote = new TestRemote(ctx, {
    settings: scriptedSettingsRemote().settings,
    mcp: {
      list: () => Promise.resolve({ ok: true as const, value: [] }),
      refresh: () => Promise.resolve({ ok: true as const, value: true }),
      openMcpDocument: () => Promise.resolve({ ok: true as const, value: { opened: true as const } }),
    },
  })
  remote.$host = { home: undefined, isLoopback: true }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-mcp apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'settingsScope', 'remote', 'remote.mcp',
    ])
  })

  it('registers the MCP section with its three stores', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const entry = slots.entries('settings.section')[0]!
    expect(entry.component).toBe(McpSection)
    expect(entry.options).toMatchObject({ id: 'mcp', order: 20 })
    expect(resolveSlotLabel(entry.options.label)).toBe('MCP')

    const injected = (entry.inject as unknown as () => McpSectionInjected)()
    expect(injected.store).toBeInstanceOf(McpStore)
    expect(injected.status).toBeInstanceOf(McpStatusStore)
    expect(injected.document).toBeInstanceOf(McpDocumentStore)
    expect(injected.hooks.mcp).toBe(injected.store.store)
    expect(injected.hooks.status).toBe(injected.status.store)
    expect(injected.hooks.document).toBe(injected.document.store)
    expect(injected.t('nav')).toBe('MCP')
    expect(injected.t('configure')).toBe('配置MCP')
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declare(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })
})
