/**
 * Floating user-message drawer that lets a reader jump to any user prompt.
 *
 * The collapsed mode is a circular toggle pinned on the right gutter (a
 * visual sibling of {@link TurnNavigator}); the open mode swaps the toggle
 * for a vertical panel listing every loaded user turn with its first-line
 * preview. The panel reuses the live Chat-snapshot navigation data, so the
 * list grows naturally when the user loads older history, and the active
 * row tracks the same `activeTurn` {@link TurnNavigator} already publishes.
 */
import {
  useEffect, useId, useRef, useState, type CSSProperties,
} from 'react'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnNavigationItem } from '../contract/snapshot.ts'
import css from './UserTurnPanel.module.css'

interface UserTurnPanelProps {
  readonly items: readonly TurnNavigationItem[]
  readonly activeTurn: number | null
  readonly onNavigate: (item: TurnNavigationItem) => void
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
 * User-message drawer. {@link items} may include turns whose `prompt` is
 * empty (mid-Turn loaded windows, compaction entries); filtering keeps the
 * drawer strictly user-facing and is also what renders the empty state
 * honest. Each row's `aria-current` mirrors {@link activeTurn} so the
 * highlighted row and {@link TurnNavigator}'s active mark stay in lockstep.
 */
export function UserTurnPanel({ items, activeTurn, onNavigate, t }: UserTurnPanelProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const labelId = useId()

  // Only turns whose loaded window contains a user prompt are user messages:
  // compaction summaries, unknown surfaces, and assistant-only steps leave
  // prompt empty, and the existing Chat build already trims them.
  const userTurns = items.filter(item => item.prompt !== '')
  const count = userTurns.length

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

  const onPick = (item: TurnNavigationItem): void => {
    onNavigate(item)
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
            {userTurns.map((item) => {
              const active = item.turn === activeTurn
              return (
                <li key={item.turn}>
                  <button
                    type="button"
                    className={active ? `${css.item} ${css.itemActive}` : css.item}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => { onPick(item) }}
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
