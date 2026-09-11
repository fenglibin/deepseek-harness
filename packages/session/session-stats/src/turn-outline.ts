/**
 * Turn-outline projection unit: a whole-log fold of every turn's opening user
 * prompt into a bounded preview, in timeline order.
 *
 * The client drawer lists only the turns a history page actually loaded. This
 * unit folds the complete durable log on the host, so the full user-message
 * list is available regardless of paging; the client pages back to a turn on
 * demand instead of listing only what it already has. The open turn joins the
 * wire view the moment its opening prompt lands, so the drawer shows a message
 * when the reader sends it rather than when the turn closes.
 *
 * @module @deepseek-ai/dsh-session-stats/turn-outline
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnOutlineEntry } from './types.ts'

/** Preview budget per prompt, matching the Chat navigation rail's own bound. */
const PROMPT_LIMIT = 160

/**
 * Fold state: finalized entries plus the open turn's captured prompt.
 *
 * `currentIsUserTurn` records whether the open turn has seen at least one
 * direct user `user/message` (source.kind === 'user') regardless of text
 * content — image-only direct prompts would otherwise leave `currentPrompt`
 * empty and the projection skip the turn, so the drawer badge would under-
 * count when a turn carried no textual prompt.
 */
interface TurnOutlineState {
  turns: TurnOutlineEntry[]
  /** Turn number of the open turn; null between turns. */
  currentTurn: number | null
  /** Bounded opening prompt of the open turn; empty until one is captured. */
  currentPrompt: string
  /** True once an own user `user/message` lands in the open turn. */
  currentIsUserTurn: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    turnOutline: TurnOutlineState
  }
}

const turnOutlineEntrySchema = z.object({
  turn: z.number().int().nonnegative(),
  prompt: z.string(),
}).strict()

const turnOutlineStateSchema = z.object({
  turns: z.array(turnOutlineEntrySchema),
  currentTurn: z.number().int().nonnegative().nullable(),
  currentPrompt: z.string(),
  currentIsUserTurn: z.boolean(),
}).strict()

const turnOutlineViewSchema = z.object({
  turns: z.array(turnOutlineEntrySchema),
}).strict()

/**
 * Join one direct user message's text blocks into a bounded single-line
 * preview. Only `source.kind === 'user'` messages qualify: steering messages
 * and injected context are not a turn's opening prompt.
 * @param event - the `user/message` event to preview.
 * @returns the bounded preview, or '' when the message carries no text.
 */
function promptOf(event: SessionEvent<'user/message'>): string {
  if (event.data.source.kind !== 'user') return ''
  let text = ''
  for (const block of event.data.content) {
    if (block.type !== 'text') continue
    text += text === '' ? block.text : ` ${block.text}`
    if (text.length >= PROMPT_LIMIT) break
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_LIMIT)
}

/**
 * Whether the open turn has produced a direct user prompt worth listing.
 * One predicate for both readers — `turn/end` decides whether to keep the
 * slot, the wire view decides whether to publish it early — so the two can
 * never disagree about which turns are user turns.
 * @param state - the current fold state.
 * @returns true once an own user message landed, whether or not it carried text.
 */
function isUserTurn(state: TurnOutlineState): boolean {
  return state.currentPrompt !== '' || state.currentIsUserTurn
}

/**
 * The open turn as an outline entry, while it qualifies as a user turn.
 * @param state - the current fold state.
 * @returns the entry, or null when no direct user prompt has landed yet.
 */
function openTurnEntry(state: TurnOutlineState): TurnOutlineEntry | null {
  if (state.currentTurn === null || !isUserTurn(state)) return null
  return { turn: state.currentTurn, prompt: state.currentPrompt }
}

/**
 * Session-stats' turn-outline projection unit.
 *
 * A `turn/start` opens a slot, the first direct user message fills its prompt,
 * and the wire view publishes the slot as soon as that prompt lands —
 * `turn/end` only moves it into the finalized log-ordered list. Turns without a
 * direct prompt (injected-only, compaction entries) stay out of the list; an
 * event outside any turn leaves the state untouched.
 */
export const turnOutlineProjectionDefinition = {
  key: 'turnOutline',
  stateVersion: 1,
  stateSchema: turnOutlineStateSchema,
  init: () => ({ turns: [], currentTurn: null, currentPrompt: '', currentIsUserTurn: false }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return { turns: state.turns, currentTurn: event.data.turn, currentPrompt: '', currentIsUserTurn: false }
    }
    if (state.currentTurn === null) return state
    if (event.type === 'user/message') {
      if (state.currentPrompt !== '') {
        // The opening prompt is already settled; still flag the turn if the
        // own user sent a (later) message with only images so the drawer does
        // not omit a direct user turn whose text never landed.
        return event.data.source.kind === 'user'
          ? { ...state, currentIsUserTurn: true }
          : state
      }
      const prompt = promptOf(event)
      if (prompt !== '') return { ...state, currentPrompt: prompt, currentIsUserTurn: state.currentIsUserTurn || event.data.source.kind === 'user' }
      // Direct user messages with image-only or empty content must still be
      // captured: the drawer renders the turn with a placeholder preview, and
      // turn/end below keeps the turn on its own user-message signal.
      return event.data.source.kind === 'user'
        ? { ...state, currentIsUserTurn: true }
        : state
    }
    if (event.type === 'turn/end') {
      if (!isUserTurn(state)) {
        return { turns: state.turns, currentTurn: null, currentPrompt: '', currentIsUserTurn: false }
      }
      return {
        turns: [...state.turns, { turn: state.currentTurn, prompt: state.currentPrompt }],
        currentTurn: null,
        currentPrompt: '',
        currentIsUserTurn: false,
      }
    }
    return state
  },
  wire: {
    viewSchema: turnOutlineViewSchema,
    view: (state) => {
      const open = openTurnEntry(state)
      return { turns: open === null ? state.turns : [...state.turns, open] }
    },
  },
} satisfies ProjectionDefinition<'turnOutline', TurnOutlineState>
