/**
 * Prompt-command settings section, browser half. Registers one settings page
 * whose list edits the `prompt-commands` settings namespace through the shared
 * settings scope; add and edit stage a draft editor, and delete is gated by an
 * in-page risk confirmation.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge and the ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { PromptCommandsController } from './controller.ts'
import { PromptCommandsSection } from './PromptCommandsSection.tsx'
import type { PromptCommandsSectionInjected } from './PromptCommandsSection.tsx'
import { zh } from './locales.ts'

export type { PromptCommandsSectionInjected, PromptCommandsSectionProps } from './PromptCommandsSection.tsx'
export type { PromptCommandEntry, PromptCommandsValue } from './controller.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.commands'

/** Settings namespace this section edits; must match the Host `command-prompt-config` namespace. */
const NAMESPACE = 'prompt-commands'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'settingsScope']

/**
 * Mount the prompt-command settings section over the `prompt-commands` namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh }), 'ui-settings-commands: section dictionaries')

  const controller = new PromptCommandsController(ctx.settingsScope.bind({ namespace: NAMESPACE }))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'prompt-commands',
    order: 16,
    label: () => t('nav'),
    locale: NS,
    inject: (): PromptCommandsSectionInjected => ({ controller }),
  }, PromptCommandsSection))
}
