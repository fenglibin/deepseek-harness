// @vitest-environment jsdom

/**
 * User-turn drawer behaviour: the collapsed badge only appears when at least
 * one loaded turn carries a user prompt; the open panel lists every such turn
 * with its prompt preview; picking a row hands the item back to the parent
 * (which performs the actual scroll); outside pointerdown and Escape each
 * close the panel; pure-assistant turns are filtered out so the drawer
 * remains strictly user-facing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TurnNavigationItem } from '../src/client/contract/snapshot.ts'
import { UserTurnPanel } from '../src/client/chat/UserTurnPanel.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function makeItems(count: number, promptFactory: (i: number) => string): TurnNavigationItem[] {
  return Array.from({ length: count }, (_, i) => ({
    turn: i + 1,
    anchorKey: `anchor-${String(i + 1)}`,
    prompt: promptFactory(i),
    response: `reply ${String(i + 1)}`,
  }))
}

describe('UserTurnPanel', () => {
  it('renders the collapsed badge with the user-turn count when at least one prompt is loaded', () => {
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

  it('filters out turns whose prompt is empty so the drawer stays user-facing', () => {
    const items: TurnNavigationItem[] = [
      { turn: 1, anchorKey: 'a-1', prompt: 'first user prompt', response: '' },
      // A loaded window starting mid-turn: the rail still anchors the row
      // but the drawer must not surface a "Turn 2" the reader never typed.
      { turn: 2, anchorKey: 'a-2', prompt: '', response: 'reply' },
      { turn: 3, anchorKey: 'a-3', prompt: 'third user prompt', response: '' },
    ]
    render(<UserTurnPanel items={items} activeTurn={null} onNavigate={vi.fn()} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: '打开用户消息列表' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2)
    expect(within(dialog).queryByText('#02')).toBeNull()
    expect(within(dialog).queryByText('共 2 条')).toBeTruthy()
  })

  it('navigates to the picked turn and closes the panel', () => {
    const items = makeItems(2, i => `turn ${String(i + 1)} prompt`)
    const onNavigate = vi.fn()
    render(<UserTurnPanel items={items} activeTurn={null} onNavigate={onNavigate} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: '打开用户消息列表' }))
    const dialog = screen.getByRole('dialog')
    const rows = within(dialog).getAllByRole('listitem')
    fireEvent.click(within(rows[1]!).getByRole('button'))

    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(items[1])
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

  it('renders nothing when no loaded turn carries a user prompt', () => {
    const items = makeItems(3, () => '')
    const { container } = render(
      <UserTurnPanel items={items} activeTurn={null} onNavigate={vi.fn()} t={t} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
