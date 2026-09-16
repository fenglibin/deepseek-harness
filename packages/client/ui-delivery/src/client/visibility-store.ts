/**
 * Visibility preference of the floating delivery card. The card is a
 * cross-session viewing surface, so one root-scope instance holds the choice
 * and persists it: a reader who hid the card keeps it hidden across reloads
 * and sessions. Declared rather than inside the component because the
 * preference outlives a mount and must be shared by the plugin's registration
 * (the framework instantiates it from this handle).
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** localStorage key holding the card's visibility preference. */
export const DELIVERY_CARD_PERSIST_KEY = 'dsh.delivery.float-card'

/**
 * What the reader asked the card to do.
 *
 * `auto` shows the card whenever a delivery task is current, which is the
 * state a reader wants without configuring anything; the two explicit values
 * let a reader pin it on or off against that default.
 */
export type DeliveryCardPreference = 'auto' | 'shown' | 'hidden'

/** The card's viewing state. */
export interface DeliveryCardState {
  /** The reader's standing choice; `auto` follows the presence of a task. */
  preference: DeliveryCardPreference
}

/** The card's complete write surface. */
type DeliveryCardActions = {
  /** Cycle auto → shown → hidden → auto. */
  cycle: (draft: DeliveryCardState) => void
  /** Pin the card visible. */
  show: (draft: DeliveryCardState) => void
  /** Pin the card hidden. */
  hide: (draft: DeliveryCardState) => void
}

/**
 * Whether the card renders for one session's current task.
 *
 * An explicit preference always wins; `auto` renders only while a task is
 * current, so a session with nothing in flight stays uncluttered.
 * @param preference - the reader's standing choice.
 * @param hasTask - whether the session has a current delivery task.
 * @returns whether the card should render.
 */
export function cardVisible(preference: DeliveryCardPreference, hasTask: boolean): boolean {
  if (preference === 'shown') return true
  if (preference === 'hidden') return false
  return hasTask
}

/**
 * Create the floating card's visibility store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createDeliveryCardStore(): EngineStoreHandle<DeliveryCardState, DeliveryCardActions> {
  return defineStore({
    // `auto` is the default: a reader who never touches the preference still
    // sees the task's progress while one is in flight, which is the whole point
    // of the surface, and sees nothing once it settles.
    init: (): DeliveryCardState => ({ preference: 'auto' }),
    persist: DELIVERY_CARD_PERSIST_KEY,
    actions: {
      cycle: (d) => {
        d.preference = d.preference === 'auto' ? 'shown' : d.preference === 'shown' ? 'hidden' : 'auto'
      },
      show: (d) => { d.preference = 'shown' },
      hide: (d) => { d.preference = 'hidden' },
    },
  })
}
