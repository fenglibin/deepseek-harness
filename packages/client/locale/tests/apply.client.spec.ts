/** locale apply wiring: service + dictionary provision and Host preference adoption. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LOCALE_SETTINGS_NAMESPACE, LocaleSettingsSchema } from '../src/locale-settings.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  let preference: string | undefined
  let revision = 0
  const namespace = () => ({
    ns: LOCALE_SETTINGS_NAMESPACE,
    schema: LocaleSettingsSchema.toJSON(),
    value: preference === undefined ? {} : { preference },
    applies: 'live' as const,
    secrets: [],
    revision,
  })
  const describe = vi.fn(async () => ({
    ok: true as const,
    value: { writable: true, hasDocument: true, namespaces: [namespace()] },
  }))
  const mutate = vi.fn(async (_ns: string, ops: { value: string }[]) => {
    preference = ops[0]!.value
    revision += 1
    return { ok: true as const, value: namespace() }
  })
  const events = new TestRemote(ctx, { settings: { describe, mutate } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, describe, mutate, events,
    setHostPreference: (next: string | undefined) => { preference = next; revision += 1 },
  }
}

describe('locale apply', () => {
  it('declares the slot service', () => {
    expect(inject).toEqual(['slots', 'remote', 'settingsScope'])
  })

  it('provides the locale service with the base dictionary', async () => {
    const before = await bench()
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const locale = before.ctx.get('locale') as LocaleRuntime
    // Base dictionary is registered: the (ns, locale) seat is occupied.
    expect(() => locale.register('common', 'zh', {})).toThrow('already has locale')
    // A fresh service opens on FALLBACK_LOCALE (zh) with no browser detection.
    expect(locale.getLocale().active).toBe('zh')
    expect(locale.getLocale().locales.map(l => l.id)).toEqual(['zh'])
  })

  it('loads and refreshes the explicit Host preference after nonblocking activation', async () => {
    const b = await bench()
    b.setHostPreference('zh')
    b.events.emit('settings/document-updated', [LOCALE_SETTINGS_NAMESPACE, 0])
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const locale = b.ctx.get('locale') as LocaleRuntime
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('zh') })
    expect(b.describe).toHaveBeenCalledTimes(2)
  })

  it('teardown is quiet without a declaration', async () => {
    const quiet = await bench()
    const fiber = quiet.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(quiet.slots.entries('settings.general.item')).toHaveLength(0)
  })
})
