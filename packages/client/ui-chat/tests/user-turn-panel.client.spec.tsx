// @vitest-environment jsdom

/**
 * User-turn drawer behaviour: the collapsed badge carries the whole-log user
 * turn count; the open panel lists every turn with its prompt preview;
 * picking a row hands the turn number back to the parent (which pages/
 * scrolls to it); outside pointerdown and Escape each close the panel.
 * The host projection already omits turns without a direct prompt, so the
 * drawer renders whatever outline it receives without further filtering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-stats/client'
import { UserTurnPanel } from '../src/client/chat/UserTurnPanel.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function makeItems(count: number, promptFactory: (i: number) => string): TurnOutlineEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    turn: i + 1,
    prompt: promptFactory(i),
  }))
}

describe('UserTurnPanel', () => {
  it('renders the collapsed badge with the whole-log user-turn count', () => {
    const items = makeItems(5, i => `prompt ${String(i + 1)}`)
    render(<UserTurnPanel items={items} activeTurn={null} onNavigate={vi.fn()} t={t} />)
    const toggle = screen.getByRole('button', { name: '打开用户消息列表' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(toggle).getByText('5')).toBeTruthy()
  })

  it('expands to a list that numbers rows by turn and shows the prompt preview', () => {
    const items = makeItems(3, i => `用户输入 ${String(i + 1)} 包含前后空白`)
    const onNavigate = vi.fn()
    render(<UserTurnPanel items={items} activeTurn={null} onNavigate={onNavigate} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: '打开用户消息列表' }))

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByText('我的对话')).toBeTruthy()
    expect(within(dialog).getByText('共 3 条')).toBeTruthy()

    const listItems = within(dialog).getAllByRole('listitem')
    expect(listItems).toHaveLength(3)
    // Whitespace is collapsed in the preview so multiple prompts render
    // without odd gaps: the first row carries the cleaned-up text.
    expect(within(listItems[0]!).getByText('用户输入 1 包含前后空白')).toBeTruthy()
    // Each row opens with a zero-padded turn tag and bounds the row's
    // visual weight.
    expect(within(listItems[1]!).getByText('#02')).toBeTruthy()
    expect(within(listItems[2]!).getByText('#03')).toBeTruthy()
  })

  it('navigates by turn number and closes the panel', () => {
    const items = makeItems(2, i => `turn ${String(i + 1)} prompt`)
    const onNavigate = vi.fn()
    render(<UserTurnPanel items={items} activeTurn={null} onNavigate={onNavigate} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: '打开用户消息列表' }))
    const dialog = screen.getByRole('dialog')
    const rows = within(dialog).getAllByRole('listitem')
    fireEvent.click(within(rows[1]!).getByRole('button'))

    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(items[1]!.turn)
    expect(screen.queryByRole('dialog')).toBeNull()
    // The badge returns so the reader can re-open it.
    expect(screen.getByRole('button', { name: '打开用户消息列表' })).toBeTruthy()
  })

  it('reflects the active turn and closes via outside pointerdown or Escape', () => {
    const items = makeItems(2, i => `turn ${String(i + 1)} prompt`)
    render(<UserTurnPanel items={items} activeTurn={2} onNavigate={vi.fn()} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: '打开用户消息列表' }))
    // The active row inherits the live navigation state so the highlighted
    // drawer entry stays aligned with the rail's `aria-current` mark.
    const dialog = screen.getByRole('dialog')
    const secondRow = within(dialog).getAllByRole('listitem')[1]!
    expect(within(secondRow).getByRole('button').getAttribute('aria-current')).toBe('true')

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '打开用户消息列表' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders nothing when the whole-log outline is empty', () => {
    const { container } = render(
      <UserTurnPanel items={[]} activeTurn={null} onNavigate={vi.fn()} t={t} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('lists unloaded turns so a fresh reader sees the full log without paging', () => {
    // The whole-log outline is independent of which Turns the chat snapshot
    // has paged in, so a freshly-loaded Session shows every user turn at
    // once; the host is responsible for paging older history on demand.
    const items = makeItems(40, i => `用户提问 #${String(i + 1)} 的完整文本`)
    render(<UserTurnPanel items={items} activeTurn={null} onNavigate={vi.fn()} t={t} />)
    const toggle = screen.getByRole('button', { name: '打开用户消息列表' })
    expect(within(toggle).getByText('40')).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(40)
  })
})
