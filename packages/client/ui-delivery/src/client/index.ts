/**
 * Delivery-discipline surface plugin, browser half: the durable
 * delivery-task Conversation node (timeline card) and the floating task card
 * pinned to the conversation body's left edge. The timeline card folds
 * `delivery/change` session events; the floating card reads the host-computed
 * `delivery`, `delivery-tasks`, and `todos` projections, stays hidden until
 * Ctrl+Shift+P asks for it, and opens the design document through the Host
 * opener. Both are read-only — the task advances through the model-facing
 * tools, so this plugin owns no delivery state and emits no events.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the conversation slots, uiConversation.events, and their session standard seats.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard useProjection seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the Chat keyed-node seat (conversation.chat.node).
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the Session Remote's Context merge (ctx.remote.session).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { DeliveryFloatCard } from './DeliveryFloatCard.tsx'
import type { DeliveryFloatCardInjected } from './DeliveryFloatCard.tsx'
import { DeliveryTaskPanel } from './DeliveryTaskPanel.tsx'
import { deliveryTaskDefinition } from './delivery-definition.ts'
import { zh, type DeliveryKey } from './locales.ts'
import { createDeliveryCardStore } from './visibility-store.ts'

export { DeliveryFloatCard, type DeliveryFloatCardInjected, type DeliveryFloatCardProps } from './DeliveryFloatCard.tsx'
export { DeliveryTaskPanel, type DeliveryTaskPanelProps } from './DeliveryTaskPanel.tsx'
export { deliveryTaskDefinition } from './delivery-definition.ts'
export type { DeliveryTaskChatData, DeliveryTaskEvent } from './delivery-definition.ts'
export {
  deliveryArtifacts, designArtifact, LEVEL_LABELS, LEVEL_PHASES, nextGate, PHASE_LABELS,
} from './delivery-phases.ts'
export {
  createDeliveryCardStore, DELIVERY_CARD_PERSIST_KEY, type DeliveryCardState,
} from './visibility-store.ts'
export type { DeliveryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The delivery surface's copy. */
    delivery: DeliveryKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'delivery'

/** Required services for the event/node registration, the opener, and dictionaries. */
export const inject = ['uiConversation', 'slots', 'locale', 'remote', 'remote.session']

/**
 * Client plugin body: register the dictionaries, the durable task
 * Conversation node, and the floating task card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const cardStore = createDeliveryCardStore()
  ctx.effect(() => ctx.locale.register(NS, { zh }), 'ui-delivery: dictionaries')
  ctx.uiConversation.events.register(deliveryTaskDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'delivery-task',
    locale: NS,
  }, DeliveryTaskPanel))
  ctx.slots.inject('conversation.side.float', () => ctx.slots.register({
    name: 'conversation.side.float',
    id: 'delivery',
    locale: NS,
    store: cardStore,
    inject: (): DeliveryFloatCardInjected => ({
      openFile: async (path) => {
        const result = await ctx.remote.session.openWorkspacePath({ path })
        if (!result.ok) throw new Error(result.error.message)
      },
    }),
  }, DeliveryFloatCard))
}
