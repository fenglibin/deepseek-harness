/** Lightweight-model settings layered over a real settings provider. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LightweightModelConfig, { LIGHTWEIGHT_MODEL_SETTINGS_NAMESPACE } from '../src/index.ts'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(config?: { provider: string; model: string }): Promise<{
  ctx: Context
  settingsFiber: Context['fiber']
  lightweight: LightweightModelConfig
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(LightweightModelConfig, config ?? {})
  return { ctx, settingsFiber, lightweight: ctx.lightweightModel }
}

describe('LightweightModelConfig', () => {
  it('reports no selection while the section stays empty', async () => {
    const bench = await boot()
    expect(bench.lightweight.currentSelection()).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('resolves the user layer over the composition entry', async () => {
    const bench = await boot({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(bench.lightweight.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await bench.lightweight.saveSelection({ provider: 'acme-gateway', model: 'acme-mini' })
    expect(bench.lightweight.currentSelection()).toEqual({ provider: 'acme-gateway', model: 'acme-mini' })
    await bench.ctx.fiber.dispose()
  })

  it('clears a saved selection back to no selection', async () => {
    const bench = await boot()
    await bench.lightweight.saveSelection({ provider: 'acme-gateway', model: 'acme-mini' })
    expect(bench.lightweight.currentSelection()).toEqual({ provider: 'acme-gateway', model: 'acme-mini' })
    await bench.lightweight.clearSelection()
    expect(bench.lightweight.currentSelection()).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('rejects a hand-written section naming a provider without a model', async () => {
    const bench = await boot()
    await expect(bench.settingsFiber.ctx.settings.replace(LIGHTWEIGHT_MODEL_SETTINGS_NAMESPACE, {
      provider: 'acme-gateway',
    })).rejects.toThrow(/provider and model must be set together/)
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    await bench.lightweight.saveSelection({ provider: 'acme-gateway', model: 'acme-mini' })
    expect(bench.lightweight.currentSelection()?.provider).toBe('acme-gateway')
    await bench.settingsFiber.dispose()
    expect(bench.lightweight.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await bench.ctx.fiber.dispose()
  })

  it('keeps the composition entry when no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(LightweightModelConfig, { provider: 'p', model: 'm' })
    await ctx.lightweightModel.saveSelection({ provider: 'other', model: 'other' })
    expect(ctx.lightweightModel.currentSelection()).toEqual({ provider: 'p', model: 'm' })
    await ctx.fiber.dispose()
  })

  it('rejects a composition entry naming a model without a provider', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(LightweightModelConfig, { model: 'm' }))
      .rejects.toThrow(/provider and model must be set together/)
    await ctx.fiber.dispose()
  })
})
