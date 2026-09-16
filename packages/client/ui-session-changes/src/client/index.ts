/**
 * Session-changes surface plugin, browser half: the changed-files list entry
 * in the conversation.input.dock strip. The list folds the per-turn
 * `deliverables` vocabulary — which `ui-deliverables` already accumulates
 * from successful first-party mutation calls — into one session-wide,
 * first-seen list, read through the session standard `useConversation` seat.
 * Each row shows the file's full path and opens it on the Host desktop.
 * Accepting a file clears it from the pending list only; nothing on disk
 * changes, and the accept record lives in a session-scoped persisted store so
 * it survives a remount and a reload.
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
// Type-only: pulls the Session Controller's Context merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Session Remote's Context merge (ctx.remote.session).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the optional `fileViewer` Context merge (ctx.get).
import type {} from '@deepseek-ai/dsh-client-ui-file-browser/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createAcceptedChangesStore } from './accept-store.ts'
import { SessionChangesDock, type SessionChangesInjected } from './SessionChangesDock.tsx'
import { zh, type SessionChangesKey } from './locales.ts'

export {
  SessionChangesDock, SessionChangesPanel, canonicalMutationPath, displayPath, isPendingChange,
  pendingChanges, sessionChanges,
  type ChangesView, type SessionChange, type SessionChangesDockProps,
  type SessionChangesInjected, type SessionChangesPanelProps,
} from './SessionChangesDock.tsx'
export { ACCEPTED_CHANGES_PERSIST_KEY, createAcceptedChangesStore, type AcceptedChanges }
  from './accept-store.ts'
export type { SessionChangesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The changed-files dock's copy. */
    'session-changes': SessionChangesKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'session-changes'

/** Required services for the dock registration, its opener, and its dictionaries. */
export const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session']

/**
 * Client plugin body: register the dictionaries and the input-dock entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const acceptStore = createAcceptedChangesStore()
  ctx.effect(() => ctx.locale.register(NS, { zh }), 'ui-session-changes: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'session-changes',
    // Above the todo and goal docks: the session's changed files are the
    // broadest summary, so they sit first in the strip.
    order: -10,
    locale: NS,
    // Session-scoped and persisted: the accept record must outlive this mount
    // and the page, or a rebind resurrects every accepted file at once.
    store: acceptStore,
    inject: (sessionId: SessionId): SessionChangesInjected => ({
      cwd: ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd,
      openFile: async (path) => {
        // The viewer resolves the session's Workspace and reports its own
        // misses; composing it out leaves the desktop opener as the only way.
        const viewer = ctx.get('fileViewer')
        if (viewer !== undefined) {
          viewer.open({ sessionId, path })
          return
        }
        const result = await ctx.remote.session.openWorkspacePath({ path })
        if (!result.ok) throw new Error(result.error.message)
      },
    }),
  }, SessionChangesDock))
}
