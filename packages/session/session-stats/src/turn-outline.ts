/**
 * Turn-outline projection unit: a whole-log fold of every turn's opening user
 * prompt into a bounded preview, in timeline order.
 *
 * The client drawer lists only the turns a history page actually loaded. This
 * unit folds the complete durable log on the host, so the full user-message
 * list is available regardless of paging; the client pages back to a turn on
 * demand instead of listing only what it already has.
 *
 * @module @deepseek-ai/dsh-session-stats/turn-outline
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnOutlineEntry } from './types.ts'

/** Preview budget per prompt, matching the Chat navigation rail's own bound. */
const PROMPT_LIMIT = 160

/** Fold state: finalized entries plus the open turn's captured prompt. */
interface TurnOutlineState {
  turns: TurnOutlineEntry[]
  /** Turn number of the open turn; null between turns. */
  currentTurn: number | null
  /** Bounded opening prompt of the open turn; empty until one is captured. */
  currentPrompt: string
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
 * Session-stats' turn-outline projection unit.
 *
 * A `turn/start` opens a slot, the first direct user message fills its prompt,
 * and `turn/end` publishes the slot when a prompt was captured. Turns without a
 * direct prompt (injected-only, compaction entries) stay out of the list; an
 * event outside any turn leaves the state untouched.
 */
export const turnOutlineProjectionDefinition = {
  key: 'turnOutline',
  stateVersion: 1,
  stateSchema: turnOutlineStateSchema,
  init: () => ({ turns: [], currentTurn: null, currentPrompt: '' }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return { turns: state.turns, currentTurn: event.data.turn, currentPrompt: '' }
    }
    if (state.currentTurn === null) return state
    if (event.type === 'user/message') {
      if (state.currentPrompt !== '') return state
      const prompt = promptOf(event)
      return prompt === '' ? state : { ...state, currentPrompt: prompt }
    }
    if (event.type === 'turn/end') {
      return state.currentPrompt === ''
        ? { turns: state.turns, currentTurn: null, currentPrompt: '' }
        : {
          turns: [...state.turns, { turn: state.currentTurn, prompt: state.currentPrompt }],
          currentTurn: null,
          currentPrompt: '',
        }
    }
    return state
  },
  wire: { viewSchema: turnOutlineViewSchema, view: state => ({ turns: state.turns }) },
} satisfies ProjectionDefinition<'turnOutline', TurnOutlineState>
