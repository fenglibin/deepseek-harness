/**
 * MCP servers settings surface, browser half. It registers the MCP navigation
 * entry over the `settings.section` slot and renders the server list through a
 * store bound to the `mcp` settings namespace the Host `dsh-mcp-manager` plugin
 * owns. This package registers no namespace of its own: every section it edits
 * lives in that Host-owned namespace.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry) and
// the ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ctx.remote and the generated `mcp` Remote namespace merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { McpSection } from './McpSection.tsx'
import type { McpSectionInjected } from './McpSection.tsx'
import { McpStore } from './mcp-store.ts'
import { McpStatusStore } from './mcp-status-store.ts'
import type { McpSettings } from './types.ts'
import { zh, type McpKey } from './locales.ts'

export type { McpSectionInjected, McpSectionProps } from './McpSection.tsx'
export type { McpServerEntry, McpHttpServer, McpSettings, McpStdioServer } from './types.ts'
export type { McpKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The MCP servers section copy. */
    'settings.mcp': McpKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.mcp'

/** The `mcp` settings namespace owned by the Host manager. */
const MCP_SETTINGS_NAMESPACE = 'mcp'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope', 'remote']

/**
 * Register the MCP servers section once the `settings.section` declaration is
 * on the ledger, bound to the `mcp` settings namespace.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh }), 'ui-settings-mcp: copy dictionaries')

  const store = new McpStore(ctx.settingsScope.bind<McpSettings>({ namespace: MCP_SETTINGS_NAMESPACE }))
  ctx.effect(() => () => { store.dispose() }, 'ui-settings-mcp: server store')

  const status = new McpStatusStore(ctx)
  ctx.effect(() => () => { status.dispose() }, 'ui-settings-mcp: status store')

  const t = ctx.locale.bind(NS) as McpSectionInjected['t']
  const injected = (): McpSectionInjected => ({
    store,
    status,
    hooks: { mcp: store.store, status: status.store },
    t,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp',
    order: 20,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, McpSection))
}
