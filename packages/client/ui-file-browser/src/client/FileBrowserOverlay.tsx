/**
 * The shell-overlay occupant: it subscribes to the shared open-request source
 * and renders {@link FileBrowserModal} for whichever request is current.
 *
 * The overlay layer is click-through and covers the whole frame, so this
 * component renders nothing at all while no request is open — that is what
 * keeps the seat free of an invisible full-frame hit target.
 */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotMap merge declaring the 'shell.overlay' hole.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { FileBrowserRequest } from './request.ts'
import { FileBrowserModal, type FileBrowserRemote } from './FileBrowserModal.tsx'

/** Injected face: the request source, the close callback, and the Remote verbs. */
export interface FileBrowserOverlayInjected {
  hooks: {
    /** The request currently being served, or undefined while closed. */
    request: HostObservable<FileBrowserRequest | undefined>
  }
  /** Withdraw the current request, closing the dialog. */
  onClose: () => void
  /** The fileBrowser Remote verbs the dialog drives. */
  remote: FileBrowserRemote
  /**
   * Open one path through the Host desktop opener, or undefined when this
   * deployment cannot reach a desktop (a remote page, or a Host without one).
   * Resolves to the refusal message, or undefined when the Host accepted it.
   */
  openNative?: ((path: string) => Promise<string | undefined>) | undefined
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
export function FileBrowserOverlay({ useRequest, onClose, remote, openNative, t }: FileBrowserOverlayProps) {
  const request = useRequest(current => current)
  return (
    <FileBrowserModal
      open={request !== undefined}
      request={request}
      onClose={onClose}
      remote={remote}
      openNative={openNative}
      t={t}
    />
  )
}
