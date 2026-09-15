/** 已归档会话设置页，浏览器半侧。 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 仅类型引用：带入 `uiWorkspace` 的 Context 合并，以及本页读取的 `useWorkspaces` 全局标准 prop。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// 仅类型引用：带入 `useSessions` 全局标准 prop。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { ArchivedSessionsSection } from './ArchivedSessionsSection.tsx'
import type { ArchivedSessionsSectionInjected } from './ArchivedSessionsSection.tsx'
import { zh, type ArchivedSessionsLocaleKey } from './locales.ts'

export type { ArchivedSessionsSectionInjected, ArchivedSessionsSectionProps } from './ArchivedSessionsSection.tsx'
export type { ArchivedSessionsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 已归档会话页的文案。 */
    'settings.archivedSessions': ArchivedSessionsLocaleKey
  }
}

/** 本插件拥有的词典命名空间。 */
const NS = 'settings.archivedSessions'

/** 设置分节注册与取消归档写入所需的全部服务。 */
export const inject = ['slots', 'locale', 'uiWorkspace']

/**
 * 把已归档会话页贡献给设置。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh }), 'ui-settings-unarchive-sessions: 词典')

  const t = ctx.locale.bind(NS)
  const injected = (): ArchivedSessionsSectionInjected => ({
    unarchive: sessionId => ctx.uiWorkspace.unarchiveSession(sessionId),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'archived-sessions',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, ArchivedSessionsSection))
}
