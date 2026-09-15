/**
 * Skills settings surface, browser half: one navigation entry that lists the
 * skills one scope holds and drives every write through the `skillAdmin`
 * Remote. The section owns no Host fact of its own — roots, entries, files, and
 * writability all arrive from the Host.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls ctx.remote and the generated `skillAdmin` namespace merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `GlobalStandardProps.useWorkspaces` merge the section reads.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SkillsSection } from './SkillsSection.tsx'
import type { SkillsSectionInjected } from './SkillsSection.tsx'
import { zh, type SkillsLocaleKey } from './locales.ts'

export type { SkillsSectionInjected, SkillsSectionProps } from './SkillsSection.tsx'
export type { SkillsLocaleKey } from './locales.ts'
export { SKILL_SCOPES, rootsInScope, type SkillScope } from './scope.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The skills section copy. */
    'settings.skills': SkillsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.skills'

/** Required services: the Settings ledger, copy, and the skills Remote faces. */
export const inject = ['slots', 'locale', 'remote', 'remote.skillAdmin']

/**
 * Reject one refused Remote call, keeping the failure's code in the message a
 * section reports.
 * @param call - the Remote method that refused.
 * @param result - the refused result.
 * @returns the error to throw.
 */
function refused(call: string, result: { readonly error: { readonly code: string; readonly message: string } }): Error {
  return new Error(`${call} failed: ${result.error.code}: ${result.error.message}`)
}

/** Contribute the skills section to Web Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh }), 'ui-settings-skills: copy dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): SkillsSectionInjected => ({
    list: async (projectRoot) => {
      const result = await ctx.remote.skillAdmin.list(projectRoot === undefined ? {} : { projectRoot })
      if (!result.ok) throw refused('skillAdmin.list', result)
      return result.value
    },
    remove: async (entryId, projectRoot) => {
      const result = await ctx.remote.skillAdmin.delete({
        entryId: entryId as never,
        ...projectRoot === undefined ? {} : { projectRoot },
      })
      if (!result.ok) throw refused('skillAdmin.delete', result)
    },
    setEnabled: async (entryId, enabled, projectRoot) => {
      const result = await ctx.remote.skillAdmin.setEnabled({
        entryId: entryId as never,
        enabled,
        ...projectRoot === undefined ? {} : { projectRoot },
      })
      if (!result.ok) throw refused('skillAdmin.setEnabled', result)
      return result.value
    },
    listFiles: async (entryId, projectRoot) => {
      const result = await ctx.remote.skillAdmin.listFiles({
        entryId: entryId as never,
        ...projectRoot === undefined ? {} : { projectRoot },
      })
      if (!result.ok) throw refused('skillAdmin.listFiles', result)
      return result.value
    },
    readFile: async (entryId, path, projectRoot) => {
      const result = await ctx.remote.skillAdmin.readFile({
        entryId: entryId as never,
        path,
        ...projectRoot === undefined ? {} : { projectRoot },
      })
      if (!result.ok) throw refused('skillAdmin.readFile', result)
      return result.value
    },
    writeFile: async (request) => {
      const result = await ctx.remote.skillAdmin.writeFile(request)
      if (!result.ok) throw refused('skillAdmin.writeFile', result)
    },
    previewImport: async (request) => {
      const result = await ctx.remote.skillAdmin.previewImport(request)
      if (!result.ok) throw refused('skillAdmin.previewImport', result)
      return result.value
    },
    previewUpload: async (request) => {
      const result = await ctx.remote.skillAdmin.previewUpload(request)
      if (!result.ok) throw refused('skillAdmin.previewUpload', result)
      return result.value
    },
    readPreviewFile: async (request) => {
      const result = await ctx.remote.skillAdmin.readPreviewFile(request)
      if (!result.ok) throw refused('skillAdmin.readPreviewFile', result)
      return result.value
    },
    commitImport: async (previewId) => {
      const result = await ctx.remote.skillAdmin.commitImport({ previewId: previewId as never })
      if (!result.ok) throw refused('skillAdmin.commitImport', result)
    },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skills',
    order: 17,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, SkillsSection))
}
