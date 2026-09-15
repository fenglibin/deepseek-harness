/**
 * Visibility preference of the floating delivery card. The card is a
 * cross-session viewing surface, so one root-scope instance holds the choice
 * and persists it: a reader who hid the card keeps it hidden across reloads
 * and sessions. Declared here rather than inside the component because the
 * preference outlives a mount and must be shared by the plugin's
 * registration (the framework instantiates it from this handle).
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** localStorage key holding the card's visibility preference. */
export const DELIVERY_CARD_PERSIST_KEY = 'dsh.delivery.float-card'

/** The card's viewing state. */
export interface DeliveryCardState {
  /** Whether the floating card renders; hidden until the reader asks for it. */
  visible: boolean
}

/** The card's complete write surface. */
type DeliveryCardActions = {
  toggle: (draft: DeliveryCardState) => void
}

/**
 * Create the floating card's visibility store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createDeliveryCardStore(): EngineStoreHandle<DeliveryCardState, DeliveryCardActions> {
  return defineStore({
    // Hidden by default: the card overlays the transcript, and its progress
    // can disagree with what the reader sees the agent doing.
    init: (): DeliveryCardState => ({ visible: false }),
    persist: DELIVERY_CARD_PERSIST_KEY,
    actions: {
      toggle: (d) => { d.visible = !d.visible },
    },
  })
}
