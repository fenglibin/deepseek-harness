/**
 * Visibility preference of the floating delivery card. The card is a
 * cross-session viewing surface, so one root-scope instance holds the choice
 * and persists it: a reader who showed the card keeps it shown across reloads
 * and sessions. Declared rather than inside the component because the
 * preference outlives a mount and must be shared by the plugin's registration
 * (the framework instantiates it from this handle).
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/**
 * localStorage key holding the card's visibility preference.
 *
 * The key carries a version suffix because the persisted shape changed: the
 * earlier three-state preference (`auto`/`shown`/`hidden`, defaulting to the
 * task-following `auto`) is not a value this schema can hold. Reusing the key
 * would rehydrate an `auto` that no longer exists into a type that cannot
 * describe it, so the new key starts every reader from the new default instead.
 */
export const DELIVERY_CARD_PERSIST_KEY = 'dsh.delivery.float-card.v2'

/**
 * What the reader asked the card to do.
 *
 * Two states, because the card's default is closed: the card overlays the
 * transcript and its progress can disagree with what the reader sees the agent
 * doing, so it appears only after Ctrl+Shift+P asks for it.
 */
export type DeliveryCardPreference = 'shown' | 'hidden'

/** The card's viewing state. */
export interface DeliveryCardState {
  /** The reader's standing choice; `hidden` until the shortcut flips it. */
  preference: DeliveryCardPreference
}

/** The card's complete write surface. */
type DeliveryCardActions = {
  /** Flip shown ↔ hidden. */
  toggle: (draft: DeliveryCardState) => void
  /** Pin the card visible. */
  show: (draft: DeliveryCardState) => void
  /** Pin the card hidden. */
  hide: (draft: DeliveryCardState) => void
}

/**
 * Whether the card renders.
 *
 * The preference is the whole answer: the card has no task-following state, so
 * a session with a task in flight stays uncluttered until the reader asks.
 * @param preference - the reader's standing choice.
 * @returns whether the card should render.
 */
export function cardVisible(preference: DeliveryCardPreference): boolean {
  return preference === 'shown'
}

/**
 * Create the floating card's visibility store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createDeliveryCardStore(): EngineStoreHandle<DeliveryCardState, DeliveryCardActions> {
  return defineStore({
    // `hidden` is the default: the card is a surface the reader opts into.
    init: (): DeliveryCardState => ({ preference: 'hidden' }),
    persist: DELIVERY_CARD_PERSIST_KEY,
    actions: {
      toggle: (d) => { d.preference = d.preference === 'shown' ? 'hidden' : 'shown' },
      show: (d) => { d.preference = 'shown' },
      hide: (d) => { d.preference = 'hidden' },
    },
  })
}
