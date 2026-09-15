// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { ArchivedSessionsSection } from '../src/client/ArchivedSessionsSection.tsx'
import type { ArchivedSessionsSectionInjected } from '../src/client/ArchivedSessionsSection.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const unarchiveSession = vi.fn<(sessionId: SessionId) => Promise<void>>(async () => {})
  ctx.provide('uiWorkspace', { unarchiveSession })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, unarchiveSession }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-unarchive-sessions browser plugin', () => {
  it('让宿主 Loader 入口保持惰性', () => {
    expect(hostApply).not.toThrow()
  })

  it('只声明页面与归档写入实际使用的服务', () => {
    expect(inject).toEqual(['slots', 'locale', 'uiWorkspace'])
  })

  it('以本地化文案注册末位的已归档会话页', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ArchivedSessionsSection)
    expect(entry.options).toMatchObject({ id: 'archived-sessions', order: 25 })
    expect(entry.locale).toBe('settings.archivedSessions')
    expect(resolveSlotLabel(entry.options.label)).toBe('已归档会话')

    const injected = (entry.inject as unknown as () => ArchivedSessionsSectionInjected)()
    await expect(injected.unarchive('session-one' as SessionId)).resolves.toBeUndefined()
    expect(b.unarchiveSession).toHaveBeenCalledWith('session-one')
    await b.ctx.fiber.dispose()
  })

  it('跟随迟到的声明与声明方的重新加载', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })

    stop()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.section')[0]?.component).toBe(ArchivedSessionsSection)
    })

    // 卸载后词典随 effect 释放，同一个命名空间可以被再次注册。
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(() => b.locale.register('settings.archivedSessions', 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
