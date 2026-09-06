// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TurnTimePanel, TurnUsagePanel } from '../src/client/chat/TurnUsagePanel.tsx'
import type { TurnTokenUsage } from '../src/client/contract/chat-nodes.ts'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonEn)

afterEach(cleanup)

describe('TurnUsagePanel', () => {
  it('shows an icon-and-total pill and opens the usage dialog on click', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 5_060,
      cacheReadTokens: 4_940,
      cacheWriteTokens: 0,
      outputTokens: 5_800,
      reasoningTokens: 42,
      totalTokens: 15_800,
      routes: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    }
    const view = render(<TurnUsagePanel usage={usage} t={t} />)

    const trigger = view.getByRole('button')
    expect(trigger.textContent).toBe('用量 15.8K tok')
    expect(trigger.querySelector('svg')).not.toBeNull()
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('本轮用量')
    // Portaled out of the trigger's row, with a heading row carrying the total.
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.firstChild?.textContent).toBe('本轮用量15,800 tok')
    const details = dialog.querySelector('[data-turn-usage-details]') as HTMLElement
    expect(details).toBeTruthy()
    expect(details.textContent).toContain('提供方 / 模型deepseek/deepseek-chat')
    expect(details.textContent).toContain('缓存命中49.4%')
    expect(details.textContent).toContain('未缓存输入5,060 tok')
    expect(details.textContent).toContain('缓存读取4,940 tok')
    expect(details.textContent).toContain('缓存写入0 tok')
    expect(details.textContent).toContain('输出5,800 tok（其中推理 42 tok）')
    expect(details.textContent).not.toContain('Total')
  })

  it('omits unavailable optional facts but always shows the cache-hit share', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    }
    const view = render(<TurnUsagePanel usage={usage} t={t} />)

    const trigger = view.getByRole('button')
    expect(trigger.textContent).toBe('用量 150 tok')
    fireEvent.click(trigger)
    expect(view.queryByText('提供方 / 模型')).toBeNull()
    expect(view.queryByText('缓存读取')).toBeNull()
    expect(view.queryByText('缓存写入')).toBeNull()
    expect(view.queryByText(/reasoning/)).toBeNull()
    // No reported cache traffic still renders a 0% cache-hit share, matching
    // the session StatsLine's whole-log reading.
    expect(view.getByText('缓存命中')).toBeTruthy()
    expect(view.getByText('0%')).toBeTruthy()
  })

  it('opens on mouse hover and closes after the pointer grace elapses', () => {
    vi.useFakeTimers()
    try {
      const usage: TurnTokenUsage = {
        uncachedInputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      }
      const view = render(<TurnUsagePanel usage={usage} t={t} />)
      const trigger = view.getByRole('button')
      expect(view.queryByRole('dialog')).toBeNull()

      fireEvent.mouseEnter(trigger)
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(view.getByRole('dialog')).toBeTruthy()

      fireEvent.mouseLeave(trigger)
      // Still open inside the grace window; closed once it elapses.
      act(() => { vi.advanceTimersByTime(199) })
      expect(view.getByRole('dialog')).toBeTruthy()
      act(() => { vi.advanceTimersByTime(1) })
      expect(view.queryByRole('dialog')).toBeNull()
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a partial cache hit below 100 in the dialog and closes on Escape or outside pointerdown', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 1,
      cacheReadTokens: 999,
      outputTokens: 100,
      totalTokens: 1_100,
    }
    const view = render(<TurnUsagePanel usage={usage} t={t} />)
    const trigger = view.getByRole('button')
    // The pill carries the compact total; cache-hit rate and exact token
    // counts stay in the dialog.
    expect(trigger.textContent).toBe('用量 1.1K tok')

    fireEvent.click(trigger)
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toContain('缓存命中99.9%')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    // A pointerdown inside the panel keeps it open; one outside closes it.
    fireEvent.pointerDown(view.getByRole('dialog'))
    expect(view.queryByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
  })
})

describe('TurnTimePanel', () => {
  it('shows a clock-and-duration pill and opens the time dialog on click', () => {
    const view = render(
      <TurnTimePanel runMs={19_000} tokensPerSecond={20} ttftMs={1_200} t={t} />,
    )
    const trigger = view.getByRole('button')
    expect(trigger.textContent).toBe('用时 19秒')
    expect(trigger.querySelector('svg')).not.toBeNull()
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(view.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('本轮用时和速度')
    expect(dialog.parentElement).toBe(document.body)
    const details = dialog.querySelector('[data-turn-time-details]') as HTMLElement
    expect(details.textContent).toContain('本轮总用时19秒')
    expect(details.textContent).toContain('输出速度（TPS）20 tok/s')
    expect(details.textContent).toContain('首 token 用时（TTFT）1.2秒')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('omits unrecorded speed and TTFT rows', () => {
    const view = render(<TurnTimePanel runMs={3_000} t={t} />)
    fireEvent.click(view.getByRole('button'))
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toContain('本轮总用时3秒')
    expect(dialog.textContent).not.toContain('输出速度')
    expect(dialog.textContent).not.toContain('首 token 用时')
  })
})
