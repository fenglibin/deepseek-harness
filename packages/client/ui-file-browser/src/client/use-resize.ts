/**
 * Drag-to-resize wiring for the file browser frame and its column split.
 *
 * Both handles move a CSS custom property on one element rather than React
 * state: a drag produces a pointermove per frame, and re-rendering the whole
 * dialog (with the tree and editor inside it) for each of those would make the
 * drag stutter. The properties are read back from the element's own computed
 * style, so the size survives a re-render without being mirrored into state.
 *
 * Sizes are clamped to the viewport and to a usable minimum, so a drag can
 * never collapse the dialog or push it off-screen.
 * @module @deepseek-ai/dsh-client-ui-file-browser/use-resize
 */

import { useCallback } from 'react'

/** Minimum usable width of the tree column, in pixels. */
const MIN_SIDE = 180

/** Minimum usable width of the content column, in pixels. */
const MIN_CONTENT = 240

/** Minimum frame size, in pixels. */
const MIN_FRAME_WIDTH = 520
const MIN_FRAME_HEIGHT = 320

/** Margin left around the frame so it never touches the viewport edge. */
const VIEWPORT_MARGIN = 16

/** Which custom property a drag writes. */
export interface ResizeSpec {
  /** The element carrying the property (the dialog frame, or the grid). */
  readonly property: '--dsl-fb-width' | '--dsl-fb-height' | '--dsl-fb-side'
  /** The axis the pointer moves along. */
  readonly axis: 'x' | 'y'
  /** The element whose size the pointer delta is measured against. */
  readonly target: HTMLElement
}

/** One drag in flight. */
interface DragState extends ResizeSpec {
  readonly startX: number
  readonly startY: number
  readonly startValue: number
}

/** The drag callback the dialog's handles attach to their pointerdown. */
export interface ResizeHandles {
  /**
   * Resize the frame. The corner grip moves width and height together, the way
   * a desktop window's corner does.
   */
  onFramePointerDown: (event: React.PointerEvent<HTMLElement>) => void
  /** Rebalance the tree column against the content column. */
  onSplitPointerDown: (event: React.PointerEvent<HTMLElement>) => void
}

/** Read a pixel-valued custom property off an element, or 0 when unset. */
function readProperty(element: HTMLElement, property: string): number {
  const raw = getComputedStyle(element).getPropertyValue(property).trim()
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Clamp one axis to what the frame may occupy. */
function clamp(spec: ResizeSpec, value: number): number {
  const viewport = spec.axis === 'x' ? window.innerWidth : window.innerHeight
  const limit = viewport - VIEWPORT_MARGIN * 2
  if (spec.property === '--dsl-fb-side') {
    // The split is bounded by the content column's own minimum, so neither
    // column can be squeezed out of existence.
    const frameWidth = spec.target.parentElement?.getBoundingClientRect().width ?? limit
    return Math.max(MIN_SIDE, Math.min(value, frameWidth - MIN_CONTENT))
  }
  const minimum = spec.property === '--dsl-fb-width' ? MIN_FRAME_WIDTH : MIN_FRAME_HEIGHT
  return Math.max(minimum, Math.min(value, limit))
}

/**
 * Begin one resize drag. The listeners live on `window` for the duration of the
 * gesture so the pointer may leave the handle (and the dialog) without ending
 * the drag, which is what makes dragging feel like a window edge.
 *
 * A spec may carry more than one property (the corner grip moves width and
 * height together); each is clamped independently against its own axis.
 * @param event - the pointerdown that started the drag.
 * @param specs - the properties to move, with their axes and the element carrying them.
 */
export function beginResize(event: React.PointerEvent<HTMLElement>, specs: readonly ResizeSpec[]): void {
  event.preventDefault()
  event.stopPropagation()
  const drags: DragState[] = specs.map(spec => ({
    ...spec,
    startX: event.clientX,
    startY: event.clientY,
    startValue: readProperty(spec.target, spec.property),
  }))
  const onMove = (move: PointerEvent): void => {
    for (const drag of drags) {
      const delta = drag.axis === 'x' ? move.clientX - drag.startX : move.clientY - drag.startY
      drag.target.style.setProperty(drag.property, `${String(clamp(drag, drag.startValue + delta))}px`)
    }
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

/**
 * Bind the frame and split drags.
 *
 * A resize that happened in a previous session is not restored: the size is
 * view state about the current window, and a stored width would land wrong on a
 * differently sized viewport.
 * @returns callbacks the handles attach to their pointerdown.
 */
export function useResizeHandles(): ResizeHandles {
  const onFramePointerDown = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const frame = event.currentTarget.closest('[role="dialog"]')
    if (!(frame instanceof HTMLElement)) return
    beginResize(event, [
      { property: '--dsl-fb-width', axis: 'x', target: frame },
      { property: '--dsl-fb-height', axis: 'y', target: frame },
    ])
  }, [])

  const onSplitPointerDown = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const grid = event.currentTarget.parentElement
    if (grid === null) return
    beginResize(event, [{ property: '--dsl-fb-side', axis: 'x', target: grid }])
  }, [])

  return { onFramePointerDown, onSplitPointerDown }
}
