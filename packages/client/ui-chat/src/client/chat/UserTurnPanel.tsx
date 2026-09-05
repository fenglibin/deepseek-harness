/**
 * Floating user-message drawer that lets a reader jump to any user prompt.
 *
 * The collapsed mode is a circular toggle pinned on the right gutter (a
 * visual sibling of {@link TurnNavigator}); the open mode swaps the toggle
 * for a vertical panel listing every user turn in the durable log with its
 * first-line preview. The panel reads the whole-log `turnOutline` projection
 * (one entry per turn that opened with a direct user prompt), so the list is
 * complete on re-entry regardless of how much history the client has paged
 * in, and the only way it changes is a new user message landing. Picking a
 * row pages older history on demand when the target turn is not yet loaded.
 */
import {
  useEffect, useId, useRef, useState, type CSSProperties,
} from 'react'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-stats/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './UserTurnPanel.module.css'

interface UserTurnPanelProps {
  /** Whole-log user-turn outline (turn + prompt), independent of paging. */
  readonly items: readonly TurnOutlineEntry[]
  readonly activeTurn: number | null
  /** Turn-number handler: the host pages older history when the turn is unloaded. */
  readonly onNavigate: (turn: number) => void
  readonly t: ChatViewSlotProps['t']
}

/** Inclusive character cap for one panel row preview. */
const PROMPT_PREVIEW_LIMIT = 80
/** One-character buffer between "#" and the number padding. */
const ZERO_PAD = (turn: number): string => String(turn).padStart(2, '0')

type SlotStyle = CSSProperties & {
  readonly '--turn-rail-band': string
}

function railBandStyle(): SlotStyle {
  return {
    '--turn-rail-band': 'calc(var(--dsh-conversation-viewport-height, 100dvh) - var(--dsh-composer-height, 152px))',
  }
}

/** Bound the user-facing preview so a quoted paste cannot blow up the row. */
function trimPrompt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= PROMPT_PREVIEW_LIMIT
    ? collapsed
    : `${collapsed.slice(0, PROMPT_PREVIEW_LIMIT)}…`
}

/**
 * User-message drawer. `items` is the whole-log outline, so every entry
 * already represents a turn with a direct user prompt — no client-side
 * filtering is needed, and the empty state honestly reports "no user
 * messages yet". Each row's `aria-current` mirrors `activeTurn` so the
 * highlighted row and {@link TurnNavigator}'s active mark stay in lockstep.
 */
export function UserTurnPanel({ items, activeTurn, onNavigate, t }: UserTurnPanelProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const labelId = useId()

  const count = items.length

  useDismissOnOutsidePointer(root, open, setOpen)

  // Esc closes the panel; the toggle button already owns Enter/Space
  // activation, so a separate listener is the only way to expose Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open])

  if (count === 0) return null

  const onPick = (turn: number): void => {
    onNavigate(turn)
    setOpen(false)
  }

  return (
    <div ref={root} className={css.slot} style={railBandStyle()}>
      {open ? (
        <div
          className={css.panel}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
        >
          <header className={css.header}>
            <span id={headingId} className={css.title}>
              {t('chat.userTurnList.title')}
            </span>
            <span id={labelId} className={css.count} aria-label={t('chat.userTurnList.total', { count })}>
              {t('chat.userTurnList.totalInline', { count })}
            </span>
          </header>
          <ol className={css.list} aria-describedby={labelId}>
            {items.map((item) => {
              const active = item.turn === activeTurn
              return (
                <li key={item.turn}>
                  <button
                    type="button"
                    className={active ? `${css.item} ${css.itemActive}` : css.item}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => { onPick(item.turn) }}
                  >
                    <span className={css.tag} aria-hidden>#{ZERO_PAD(item.turn)}</span>
                    <span className={css.preview}>{trimPrompt(item.prompt)}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      ) : (
        <button
          type="button"
          className={css.toggle}
          aria-expanded="false"
          aria-label={t('chat.userTurnList.toggle')}
          onClick={() => { setOpen(true) }}
        >
          <span className={css.toggleBadge}>{count}</span>
        </button>
      )}
    </div>
  )
}
