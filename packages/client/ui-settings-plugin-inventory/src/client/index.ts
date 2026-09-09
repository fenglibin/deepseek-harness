/** Host plugin inventory registered into Web Settings, with its enablement writes. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the 'settings.agentPreset' LocaleNamespaceMap merge, whose
// dictionaries the shipped-preset name resolution below reads.
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
// Type-only: declares the agentPresets Remote face the row write below calls.
import type {} from '@deepseek-ai/dsh-agent-presets/remote'
// Inline-safe shared fold: shipped ids map to dictionary keys in one home.
import { presetDisplayText } from '@deepseek-ai/dsh-agent-presets/display'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import { zh, type PluginInventoryLocaleKey } from './locales.ts'

export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Host plugin inventory copy. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registration and the Remote faces it writes through. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.agentPresets']

/**
 * Reject one refused Remote write, keeping the failure's code in the message
 * the tab reports.
 * @param call - what the tab asked the Host for, named by the Remote method.
 * @param result - the refused result.
 * @returns the error to throw.
 */
function refused(call: string, result: { readonly error: { readonly code: string; readonly message: string } }): Error {
  return new Error(`${call} failed: ${result.error.code}: ${result.error.message}`)
}

/** Contribute the lazy inventory tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: PluginInventorySettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) throw refused('pluginInventory.list', result)
    return result.value
  }
  const setEnabled: PluginInventorySettingsTabInjected['setEnabled'] = async (entryId, enabled) => {
    const result = await ctx.remote.pluginInventory.setEnabled(entryId, enabled)
    if (!result.ok) throw refused('pluginInventory.setEnabled', result)
  }
  const setPresetRowDisabled: PluginInventorySettingsTabInjected['setPresetRowDisabled'] = async (
    agentPreset, entryId, disabled,
  ) => {
    const result = await ctx.remote.agentPresets.setRowDisabled(agentPreset, entryId, disabled)
    if (!result.ok) throw refused('agentPresets.setRowDisabled', result)
  }
  const readme: PluginInventorySettingsTabInjected['readme'] = async (moduleName) => {
    const result = await ctx.remote.pluginInventory.readme(moduleName)
    if (!result.ok) throw refused('pluginInventory.readme', result)
    return result.value
  }
  const describe: PluginInventorySettingsTabInjected['describe'] = async (moduleName) => {
    const result = await ctx.remote.pluginInventory.describe(moduleName)
    if (!result.ok) throw refused('pluginInventory.describe', result)
    return result.value
  }
  // Resolved per call over ui-agent-preset's dictionaries, so a language
  // switch re-resolves shipped names; user-authored metadata passes through.
  const agentPresetCopy = ctx.locale.bind('settings.agentPreset')
  const presetName: PluginInventorySettingsTabInjected['presetName'] = preset =>
    presetDisplayText(preset, agentPresetCopy).name
  const injected = (): PluginInventorySettingsTabInjected => ({
    list, setEnabled, setPresetRowDisabled, readme, describe, presetName,
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInventorySettingsTab))
}
