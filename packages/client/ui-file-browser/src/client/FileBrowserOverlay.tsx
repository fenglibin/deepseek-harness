/**
 * The shell-overlay occupant: it subscribes to the shared open-request source
 * and renders {@link FileBrowserModal} for whichever Workspace was requested.
 *
 * The overlay layer is click-through and covers the whole frame, so this
 * component renders nothing at all while no request is open — that is what
 * keeps the seat free of an invisible full-frame hit target.
 */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotMap merge declaring the 'shell.overlay' hole.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { FileBrowserRequest } from './index.ts'
import { FileBrowserModal, type FileBrowserRemote } from './FileBrowserModal.tsx'

/** Injected face: the request source, the close callback, and the Remote verbs. */
export interface FileBrowserOverlayInjected {
  hooks: {
    /** The Workspace currently being browsed, or undefined while closed. */
    request: HostObservable<FileBrowserRequest | undefined>
  }
  /** Withdraw the current request, closing the dialog. */
  onClose: () => void
  /** The fileBrowser Remote verbs the dialog drives. */
  remote: FileBrowserRemote
}

/** Full composed props of the overlay occupant. */
export type FileBrowserOverlayProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<FileBrowserOverlayInjected>
  & PropsLocale<'fileBrowser'>

/**
 * Render the file browser dialog for the current request.
 * @param props - composed slot props (request hook, close callback, Remote verbs, locale seat).
 * @returns the dialog element, or nothing while no request is open.
 */
export function FileBrowserOverlay({ useRequest, onClose, remote, t }: FileBrowserOverlayProps) {
  const request = useRequest(current => current)
  return (
    <FileBrowserModal
      open={request !== undefined}
      workspace={request === undefined ? undefined : { workspaceId: request.workspaceId, title: request.title }}
      onClose={onClose}
      remote={remote}
      t={t}
    />
  )
}
