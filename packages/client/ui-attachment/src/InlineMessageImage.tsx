/**
 * Inline message image: a small thumbnail that sits inside a user message's
 * text line, with a hover preview and a click-to-open original lightbox. It
 * shares {@link MessageImage}'s durable load arm — a session-authorized URL
 * with retry — but renders inline so text and images flow in one line instead
 * of splitting into separate gallery blocks.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ImageLightbox } from './ImageLightbox.tsx'
import type { ImageLoader, MessageImageLabels, MessageImageSpec } from './MessageImage.tsx'
import css from './InlineMessageImage.module.css'

/** Vertical clearance the hover preview needs plus its drop gap. */
const HOVER_PREVIEW_SPACE = 264

/**
 * Fixed-position style floating the hover preview above the thumbnail, or
 * below it when the viewport top has no room.
 * @param anchor - the thumbnail element, or null while unmounted.
 * @returns the fixed-offset style, or a hidden fallback without an anchor.
 */
function hoverPreviewStyle(anchor: HTMLElement | null): CSSProperties {
  if (anchor === null) return { display: 'none' }
  const rect = anchor.getBoundingClientRect()
  const gap = 8
  const showAbove = rect.top > HOVER_PREVIEW_SPACE || rect.top > window.innerHeight - rect.bottom
  return showAbove
    ? { left: rect.left + rect.width / 2, top: rect.top - gap, transform: 'translate(-50%, -100%)' }
    : { left: rect.left + rect.width / 2, top: rect.bottom + gap, transform: 'translate(-50%, 0)' }
}

/**
 * Render one inline message image.
 * @param props.image - the durable reference to load, or the local preview to display.
 * @param props.load - session-authorized URL loader for the durable arm.
 * @param props.labels - resolved strings (tooltip, loading, retry, lightbox).
 * @returns the inline thumbnail, or the retry control on failure.
 */
export function InlineMessageImage({ image, load, labels }: {
  image: MessageImageSpec
  load: ImageLoader
  labels: MessageImageLabels
}) {
  const preview = 'preview' in image ? image.preview : undefined
  const attachment = 'attachment' in image ? image.attachment : undefined
  const [loaded, setLoaded] = useState<string | null>(() =>
    attachment === undefined ? null : (load.peek?.(attachment) ?? null))
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const [hovering, setHovering] = useState(false)
  const frameRef = useRef<HTMLButtonElement | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => { setAttempt(current => current + 1) }, [])
  const close = useCallback(() => { setOpen(false) }, [])

  useEffect(() => {
    if (attachment === undefined) return
    let live = true
    setError(false)
    setLoaded(load.peek?.(attachment) ?? null)
    void load(attachment).then((url) => { if (live) setLoaded(url) }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [attachment, load, attempt])

  const src = preview?.url ?? loaded
  const label = (preview?.name ?? attachment?.name) ?? labels.image

  if (error) {
    return (
      <button type="button" className={css.error} aria-label={labels.loadFailed} onClick={retry}>
        {labels.loadFailed}
      </button>
    )
  }

  return (
    <>
      <button
        ref={frameRef}
        type="button"
        className={css.frame}
        title={labels.open}
        aria-label={labels.openNamed(label)}
        onClick={() => { if (src !== null) setOpen(true) }}
        onMouseEnter={() => { setHovering(true) }}
        onMouseLeave={() => { setHovering(false) }}
        onFocus={() => { setHovering(true) }}
        onBlur={() => { setHovering(false) }}
      >
        {src === null ? <span className={css.loading}>{labels.loading}</span> : <img src={src} alt={label} />}
      </button>
      {hovering && src !== null && createPortal(
        <div className={css.hoverPreview} aria-hidden="true" style={hoverPreviewStyle(frameRef.current)}>
          <img className={css.hoverPreviewImg} src={src} alt={label} />
        </div>,
        document.body,
      )}
      {open && src !== null && <ImageLightbox src={src} alt={label} labels={labels.lightbox} onClose={close} />}
    </>
  )
}
