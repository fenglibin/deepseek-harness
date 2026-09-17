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
// Type-only: pulls the layout's SlotMap merge declaring the root-scoped
// `shell.overlay` hole this plugin's full-screen viewer occupies.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the Session Controller's Context merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Session Remote's Context merge (ctx.remote.session).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the optional `fileViewer` Context merge (ctx.get).
import type {} from '@deepseek-ai/dsh-client-ui-file-browser/client'
// Type-only: registers the `sessionFileRevisions` Remote namespace merge, so
// `ctx.remote.sessionFileRevisions` resolves to this package's verbs.
import type {} from '@deepseek-ai/dsh-api-session-file-revisions/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RevisionDiff, RevisionEntry, RevertFileResult } from '@deepseek-ai/dsh-api-session-file-revisions/types'
import { RevisionError, type RevisionRemote } from './revision-remote.ts'
import { createAcceptedChangesStore } from './accept-store.ts'
import { SessionChangesDock, type SessionChangesInjected } from './SessionChangesDock.tsx'
import { RevisionViewerOccupant, type RevisionViewerInjected } from './RevisionDiffOverlay.tsx'
import { createRevisionViewerSource } from './revision-viewer-request.ts'
import { zh, type SessionChangesKey } from './locales.ts'

export {
  SessionChangesDock, SessionChangesPanel, canonicalMutationPath, displayPath, isPendingChange,
  pendingChanges, sessionChanges,
  type ChangesView, type SessionChange, type SessionChangesDockProps,
  type SessionChangesInjected, type SessionChangesPanelProps,
} from './SessionChangesDock.tsx'
export { ACCEPTED_CHANGES_PERSIST_KEY, createAcceptedChangesStore, type AcceptedChanges }
  from './accept-store.ts'
export { RevisionError, revisionFailureText, type RevisionRemote } from './revision-remote.ts'
export {
  RevisionDiffOverlay, RevisionViewerOccupant, MAX_VISIBLE_ROWS,
  type RevisionDiffOverlayProps, type RevisionViewerInjected, type RevisionViewerOccupantProps,
} from './RevisionDiffOverlay.tsx'
export {
  createRevisionViewerSource, type RevisionViewerRequest, type RevisionViewerSource,
} from './revision-viewer-request.ts'
export {
  EMPTY_SIDE_BY_SIDE, MAX_INLINE_DIFF_CHARS, sideBySide, unifiedDiffText,
  type DiffRow, type DiffSide, type DiffSideKind, type InlineSpan, type SideBySide,
} from './revision-diff-model.ts'
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
 * The revision verbs the dock drives, over the session-revisions Remote.
 *
 * The namespace exists only when this composition both composes the Host
 * controller and mounts the namespace in its Client Remote assembly, so an
 * absent one is capability absence: the dock hides the view-changes and revert
 * controls and keeps the plain accept list.
 * @param ctx - client root context.
 * @returns the verbs, or undefined when the Remote namespace is absent.
 */
function remoteVerbs(ctx: ClientContext): RevisionRemote | undefined {
  // Optional-service read: the namespace is capability absence when this
  // composition mounts no Host controller, so it must not ride the declared
  // inject face (reading `ctx.remote.<ns>` there throws without the inject).
  const remote = ctx.get('remote.sessionFileRevisions')
  if (remote === undefined) return undefined
  return {
    list: async (id: string): Promise<readonly RevisionEntry[]> => {
      const result = await remote.list({ sessionId: id as SessionId })
      if (!result.ok) throw new RevisionError(result.error.code, result.error.message)
      return result.value.entries
    },
    diff: async (id: string, path: string): Promise<RevisionDiff> => {
      const result = await remote.diff({ sessionId: id as SessionId, path })
      // The failure code survives the crossing: the panel decides what to say
      // from it, and only an unmapped code falls back to the Host's wording.
      if (!result.ok) throw new RevisionError(result.error.code, result.error.message)
      return result.value
    },
    // Omitting `path` reverts every path the Host recorded for this session.
    // The Host owns that set, so the dock does not narrow it to the rows the
    // page happens to hold: a client that paged in part of a long Session
    // would otherwise silently revert only part of the change.
    revertAll: async (): Promise<readonly RevertFileResult[]> => {
      const current = ctx.sessions.list.getSnapshot().current
      if (current === undefined) return []
      const result = await remote.revert({ sessionId: current })
      if (!result.ok) throw new RevisionError(result.error.code, result.error.message)
      return result.value.results
    },
  }
}

/**
 * Client plugin body: register the dictionaries, the input-dock entry, and the
 * full-screen viewer the dock opens.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const acceptStore = createAcceptedChangesStore()
  // One source spanning both registrations: the dock publishes a request and
  // the overlay occupant renders it. The dock is session-scoped and the viewer
  // is root-scoped, so this observable — not the component tree — is what
  // carries a request across that boundary.
  const viewer = createRevisionViewerSource()
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
      revisions: remoteVerbs(ctx),
      openViewer: viewer.publish,
      openFile: async (path) => {
        // The viewer resolves the session's Workspace and reports its own
        // misses; composing it out leaves the desktop opener as the only way.
        const viewerService = ctx.get('fileViewer')
        if (viewerService !== undefined) {
          viewerService.open({ sessionId, path })
          return
        }
        const result = await ctx.remote.session.openWorkspacePath({ path })
        if (!result.ok) throw new Error(result.error.message)
      },
    }),
  }, SessionChangesDock))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-changes-viewer',
    locale: NS,
    inject: (): RevisionViewerInjected => ({
      hooks: { request: viewer.requests },
      onClose: () => { viewer.publish(undefined) },
      revisions: remoteVerbs(ctx),
    }),
  }, RevisionViewerOccupant))
}
