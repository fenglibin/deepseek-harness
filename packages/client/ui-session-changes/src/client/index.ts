/**
 * Session-changes surface plugin, browser half: the changed-files list entry
 * in the conversation.input.dock strip. The list folds the per-turn
 * `deliverables` vocabulary — which `ui-deliverables` already accumulates
 * from successful first-party mutation calls — into one session-wide,
 * first-seen list, read through the session standard `useConversation` seat.
 * Accepting a file clears it from the surface only (component-local state);
 * nothing on disk changes.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the conversation input-dock slot and its session standard seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard useConversation seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { SessionChangesDock } from './SessionChangesDock.tsx'
import { en, zh, type SessionChangesKey } from './locales.ts'

export {
  SessionChangesDock, SessionChangesPanel, sessionChanges,
  type ProducedChange, type SessionChangesDockProps, type SessionChangesPanelProps,
} from './SessionChangesDock.tsx'
export type { SessionChangesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The changed-files dock's copy. */
    'session-changes': SessionChangesKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'session-changes'

/** Required services for the dock registration and its dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the input-dock entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-changes: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'session-changes',
    // Above the todo and goal docks: the session's changed files are the
    // broadest summary, so they sit first in the strip.
    order: -10,
    locale: NS,
  }, SessionChangesDock))
}
