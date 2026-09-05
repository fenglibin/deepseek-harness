/**
 * Visual body of one inline image chip: the DecoratorNode's React face. A
 * thumbnail opens a document-level original preview; the remove button asks
 * the owning shell to drop the node. All user-facing strings arrive as
 * insert-time cached labels — the decorator sits outside the slot locale
 * seat, so the node carries them like ReferenceChipNode carries its label.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DraftAttachmentId } from '../../contract/input.ts'
import css from './ImageChip.module.css'

/** Display inputs of one image chip (the node's cached owner projections). */
export interface ImageChipProps {
  /** Browser-owned draft attachment id (remove routing key). */
  readonly attachmentId: DraftAttachmentId
  /** Object URL the thumbnail renders. */
  readonly previewUrl: string
  /** Original file name; empty renders the pending alt. */
  readonly name: string
  /** Intrinsic pixel width, when the intake probe has resolved it. */
  readonly width?: number
  /** Intrinsic pixel height, when the intake probe has resolved it. */
  readonly height?: number
  /** Localized remove-button accessible name. */
  readonly removeLabel: string
  /** Localized fallback alt for a nameless image. */
  readonly pendingAlt: string
  /** Localized preview dialog accessible name. */
  readonly lightboxDialog: string
  /** Localized preview close-button accessible name. */
  readonly lightboxClose: string
  /** Drop this chip; undefined only for a deserialized node (never mounted here). */
  readonly onRemove: ((id: DraftAttachmentId) => void) | undefined
}

/**
 * Render one inline image chip and its original preview.
 * @param props - attachment display cache, localized labels, and the remove callback.
 * @returns the chip capsule plus a body-portal lightbox while previewing.
 */
export function ImageChip({
  attachmentId, previewUrl, name, width, height,
  removeLabel, pendingAlt, lightboxDialog, lightboxClose, onRemove,
}: ImageChipProps) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [open])

  const alt = name === '' ? pendingAlt : name
  return (
    <>
      <span className={css.chip}>
        <button
          type="button"
          className={css.thumb}
          aria-label={lightboxDialog}
          onClick={() => { setOpen(true) }}
        >
          <img
            className={css.img}
            src={previewUrl}
            alt={alt}
            {...(width === undefined || height === undefined ? {} : { width, height })}
          />
        </button>
        <button
          type="button"
          className={css.remove}
          aria-label={removeLabel}
          onClick={() => { onRemove?.(attachmentId) }}
        >
          <IconCloseOutline16 size={12} />
        </button>
      </span>
      {open && createPortal(
        <div className={css.backdrop} role="dialog" aria-modal="true" aria-label={lightboxDialog}>
          <div className={css.mask} aria-hidden="true" onMouseDown={close} />
          <img className={css.preview} src={previewUrl} alt={alt} />
          <button ref={closeRef} type="button" className={css.close} aria-label={lightboxClose} onClick={close}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}
