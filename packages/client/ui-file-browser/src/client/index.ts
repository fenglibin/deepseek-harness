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
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
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

/** One open request: which Workspace the operator asked to browse. */
export interface FileBrowserRequest {
  readonly workspaceId: WorkspaceId
  readonly title: string
}

/**
 * Required services (cordis fiber inject). The target slot and the row-menu
 * service are both owned by ui-workspace, whose activation order relative to
 * this plugin is not constrained; `slots.inject` and the row-menu service
 * handle the waiting.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.fileBrowser', 'workspaceRowMenu']

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
      publish({ workspaceId: workspace.workspaceId, title: workspace.title })
    },
  }), 'ui-file-browser: row menu entry')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: OVERLAY_ID,
    locale: NS,
    inject: (): FileBrowserOverlayInjected => ({
      hooks: { request: requests },
      onClose: () => { publish(undefined) },
      remote,
    }),
  }, FileBrowserOverlay))
}
