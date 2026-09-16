/**
 * Workspace file browser, browser half. Two registrations share one piece of
 * state:
 *
 * - a `ctx.workspaceRowMenu` entry named "文件浏览器", which pushes the
 *   Workspace it was invoked for onto the open-request source;
 * - a `shell.overlay` entry, which subscribes to that source and renders the
 *   dialog for whichever Workspace is currently requested.
 *
 * The source lives in this `apply` closure rather than a module singleton or a
 * declared store: the request is per-plugin-instance ephemeral view state that
 * only these two registrations read, and creating it in `apply` is the only
 * place its lifetime can follow the plugin fiber.
 *
 * The dialog's Remote verbs arrive through the inject face as plain callbacks —
 * the component never sees `ctx`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { resolveViewPath, workspaceOfSession } from './view-target.ts'
import type { FileBrowserRequest } from './request.ts'
// Type-only: pulls the `workspaceRowMenu` registry and the SlotMap merge for
// the row-menu contribution and the shell overlay hole.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { FileBrowserRemote } from './FileBrowserModal.tsx'
import type { FileBrowserOverlayInjected } from './FileBrowserOverlay.tsx'
import { FileBrowserOverlay } from './FileBrowserOverlay.tsx'
import { zh } from './locales.ts'

export type { FileBrowserRemote, FileBrowserContentValue, FileBrowserModalProps } from './FileBrowserModal.tsx'

/** Locale namespace owning this plugin's copy. */
const NS = 'fileBrowser'

/** Menu entry id this plugin contributes. */
const MENU_ID = 'workspace-file-browser'

/** Shell-overlay entry id this plugin contributes. */
const OVERLAY_ID = 'file-browser'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The file browser dialog's chrome, tree verbs, and degrade notices. */
    fileBrowser: keyof typeof zh
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional read-only file viewer face for session file links. */
    fileViewer: FileViewer
  }
}

/** One session file a caller asked to view read-only. */
export interface FileViewerOpenRequest {
  /** Session whose file link was followed; resolves to its Workspace. */
  readonly sessionId: SessionId
  /** Workspace-relative path as the session reported it. */
  readonly path: string
}

/**
 * Outcome of one {@link FileViewer.open} call. A `no-workspace` result is
 * reported rather than thrown: the caller renders a notice, and the miss must
 * never fall back to the Host desktop opener — that fallback is what makes a
 * session link useless on a remote or mobile browser.
 */
export type FileViewerOpenResult =
  | { readonly kind: 'opened' }
  | { readonly kind: 'no-workspace' }

/**
 * The plugin's face for opening one file read-only, reached by sibling plugins
 * through `ctx.get('fileViewer')`. Absence of the service is the off state.
 */
export interface FileViewer {
  /**
   * Open one session file in the read-only viewer.
   * @param request - session identity and the workspace-relative path to show.
   * @returns whether the request reached the viewer or no Workspace backed the session.
   */
  open(request: FileViewerOpenRequest): FileViewerOpenResult
}

/**
 * Required services (cordis fiber inject). The target slot and the row-menu
 * service are both owned by ui-workspace, whose activation order relative to
 * this plugin is not constrained; `slots.inject` and the row-menu service
 * handle the waiting. `remote.session` is declared for the namespace the
 * desktop opener calls, matching the convention that every `ctx.<name>` used
 * here is a declared injection; the namespace service itself is resolved by
 * key, so the declaration documents the dependency rather than gating it.
 */
export const inject = [
  'slots', 'locale', 'remote', 'remote.fileBrowser', 'remote.session', 'workspaceRowMenu', 'workspaces',
]

/**
 * Register the menu entry and the dialog, sharing one open-request source.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh }), 'ui-file-browser: dictionaries')
  const t = ctx.locale.bind(NS)

  const remote: FileBrowserRemote = {
    // The generated namespace returns RemoteResult envelopes; the dialog reads
    // `ok`/`error` directly, so the namespace face passes through unchanged.
    list: request => ctx.remote.fileBrowser.list(request),
    read: request => ctx.remote.fileBrowser.read(request),
    write: request => ctx.remote.fileBrowser.write(request),
    create: request => ctx.remote.fileBrowser.create(request),
    rename: request => ctx.remote.fileBrowser.rename(request),
    delete: request => ctx.remote.fileBrowser.delete(request),
    search: request => ctx.remote.fileBrowser.search(request),
  } satisfies FileBrowserRemote

  // The shared request slot. `getSnapshot` returns the identical value until a
  // new request lands, which is what the renderer's hook binding requires.
  let current: FileBrowserRequest | undefined
  const listeners = new Set<() => void>()
  const requests: HostObservable<FileBrowserRequest | undefined> = {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const publish = (next: FileBrowserRequest | undefined): void => {
    current = next
    for (const listener of listeners) listener()
  }

  // The registration is an effect of this fiber, so unloading the plugin
  // removes its entry and reloading it re-adds one; `slots.inject` below gives
  // the overlay registration the same lifetime.
  ctx.effect(() => ctx.workspaceRowMenu.register({
    id: MENU_ID,
    label: t('menu.open'),
    order: 10,
    onSelect: (workspace: WorkspaceView) => {
      publish({ kind: 'workspace', workspaceId: workspace.workspaceId, title: workspace.title })
    },
  }), 'ui-file-browser: row menu entry')

  // The face siblings reach through `ctx.get('fileViewer')`. It resolves the
  // session's Workspace itself so the mapping has one owner: a caller only
  // knows which session's link was followed.
  const workspaces = ctx.get('workspaces')
  ctx.effect(() => ctx.reflect.provide('fileViewer', {
    open: ({ sessionId, path }): FileViewerOpenResult => {
      const workspace = workspaces === undefined ? undefined : workspaceOfSession(workspaces, sessionId)
      // A session with no Workspace (a subagent, or an unregistered cwd) is
      // reported through the viewer rather than opened through the desktop:
      // falling back is what makes the link useless on a remote or mobile
      // browser.
      if (workspace === undefined) {
        publish({ kind: 'unavailable', path, reason: 'no-workspace' })
        return { kind: 'no-workspace' }
      }
      publish({
        kind: 'file',
        workspaceId: workspace.workspaceId,
        path: resolveViewPath(workspace, path),
        title: workspace.title,
        readOnly: true,
      })
      return { kind: 'opened' }
    },
  } satisfies FileViewer), 'ui-file-browser: file viewer face')

  /**
   * Hand one viewed file to the Host desktop opener. The request carries a
   * workspace-relative path, but the opener resolves against the Host process's
   * own cwd, so it must be rebased onto the Workspace root first — the same
   * step `ui-chat`'s opener performs. The outcome is returned rather than
   * thrown so the dialog reports a refusal in place: replacing the request
   * would discard the file the operator is looking at.
   * @param path - workspace-relative path to open.
   * @returns the refusal message, or undefined when the Host accepted it.
   */
  const openInDesktop = async (path: string): Promise<string | undefined> => {
    const open = current
    const workspaceId = open?.kind === 'file' || open?.kind === 'workspace' ? open.workspaceId : undefined
    const root = workspaceId === undefined
      ? undefined
      : workspaces?.list.getSnapshot().items
        .find(workspace => workspace.workspaceId === workspaceId)?.path
    const result = await ctx.remote.session
      .openWorkspacePath({ path: root === undefined ? path : resolveWorkspacePath(root, path) })
      .catch(() => undefined)
    if (result === undefined) return t('content.openLocalFailed')
    return result.ok ? undefined : result.error.message
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: OVERLAY_ID,
    locale: NS,
    inject: (): FileBrowserOverlayInjected => ({
      hooks: { request: requests },
      onClose: () => { publish(undefined) },
      remote,
      // The desktop opener is offered only where it can work: the page is on
      // the Host itself. Its availability is additionally probed by the
      // viewport's own `canOpenWorkspacePath` call before the action renders.
      openNative: ctx.remote.$host.isLoopback ? openInDesktop : undefined,
    }),
  }, FileBrowserOverlay))
}
