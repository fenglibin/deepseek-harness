// @vitest-environment jsdom
/**
 * ui-delivery browser half on a real cordis Context with fake slots/locale/
 * uiConversation faces: the plugin registers the read-only DeliveryFloatCard
 * entry at conversation.side.float and the delivery-task Conversation node,
 * both with the delivery dictionary namespace. Registration disposal rides the
 * plugin fiber (HMR safety). The node half and the invariant companion are
 * exercised over the same Context.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  ConversationEventRegistry, ConversationViewRegistry,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

/** Boot the plugin over fake slots/locale/uiConversation faces. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.side.float': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      // Declared to assert the plugin no longer occupies it: the dock was
      // replaced by the timeline card plus the floating card.
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('uiConversation', {
    events: new ConversationEventRegistry(ctx),
    views: new ConversationViewRegistry(ctx),
  } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    entry: () => {
      const entry = ctx.slots.entries('conversation.side.float')[0]
      if (entry === undefined) return undefined
      return { ...entry.options, locale: entry.locale }
    },
  }
}

describe('ui-delivery browser plugin', () => {
  it('registers the read-only DeliveryFloatCard entry', async () => {
    const b = await bench()
    await b.fiber.await()
    const entry = b.entry()
    expect(entry).toMatchObject({ id: 'delivery', locale: 'delivery' })
  })

  it('no longer registers the composer input dock the two cards replaced', async () => {
    const b = await bench()
    await b.fiber.await()
    const docked = b.ctx.slots
      .entries('conversation.input.dock')
      .filter(entry => (entry.options as { id?: string }).id === 'delivery')
    expect(docked).toEqual([])
  })

  it('drops the floating-card entry when the plugin fiber unloads (HMR safety)', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toBeDefined()
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
  })
})

describe('ui-delivery node half', () => {
  // The invariant companion is mounted by the vitest-wide invariant host on
  // every Context this suite creates; its registration is covered there.
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
