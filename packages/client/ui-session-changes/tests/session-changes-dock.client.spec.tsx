// @vitest-environment jsdom

/**
 * ui-session-changes browser half: the session-wide change folding over
 * per-turn deliverables, the dock's collapse/expand + accept behavior, and
 * the adapter-owned accept set's survival across a new request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  ConversationLocationDataStore, ConversationSnapshot, ConversationTurnDataMap, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DeliverablesTurnData } from '@deepseek-ai/dsh-client-ui-deliverables/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  SessionChangesDock, SessionChangesPanel, sessionChanges, type ProducedChange,
} from '../src/client/SessionChangesDock.tsx'
import { zh } from '../src/client/locales.ts'
// Type-only: registers the `session-changes` LocaleNamespaceMap merge so the
// dock's PropsLocale resolves `t` in this program.
import '@deepseek-ai/dsh-client-ui-session-changes/client'

/** A single-namespace Turn data store, mirroring the engine's read-only face. */
class TestTurnDataStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly values = new Map<string, unknown>()

  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return this.values.get(key) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }

  set<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
    value: ConversationTurnDataMap[Key],
  ): void {
    this.values.set(key, value)
  }
}

function turnLocation(turn: number, changes?: readonly ProducedChange[]): TurnLocation {
  const data = new TestTurnDataStore()
  if (changes !== undefined) {
    const deliverables: DeliverablesTurnData = {
      produced: changes.map((change, index) => ({ seq: index + 1, ...change })),
    }
    data.set('deliverables', deliverables)
  }
  return { turn, start: undefined, end: undefined, status: 'closed', steps: [], data }
}

/** A Conversation snapshot whose chat view carries the given turns. */
function conversationOf(turns: readonly TurnLocation[]): ConversationSnapshot {
  const byTurn = new Map(turns.map(turn => [turn.turn, turn]))
  const chat = { timeline: { turnOrder: turns.map(turn => turn.turn), turns: byTurn } }
  return {
    views: { get: (target: string) => target === 'chat' ? chat : undefined },
    activeTargets: new Set(),
  } as unknown as ConversationSnapshot
}

const t: Parameters<typeof SessionChangesPanel>[0]['t'] = makeTranslate(zh, commonZh)

describe('sessionChanges folding', () => {
  it('folds every turn into one first-seen list', () => {
    const snapshot = conversationOf([
      turnLocation(1, [
        { path: 'a.txt', operation: 'write' },
        { path: 'b.txt', operation: 'edit' },
      ]),
      turnLocation(2, [
        { path: 'b.txt', operation: 'edit' },
        { path: 'c.txt', operation: 'write' },
      ]),
    ])
    expect(sessionChanges(snapshot)).toEqual([
      { path: 'a.txt', operation: 'write' },
      { path: 'b.txt', operation: 'edit' },
      { path: 'c.txt', operation: 'write' },
    ])
  })

  it('keeps the earliest operation kind for a file mutated across turns', () => {
    const snapshot = conversationOf([
      turnLocation(1, [{ path: 'a.txt', operation: 'write' }]),
      turnLocation(2, [{ path: 'a.txt', operation: 'edit' }]),
    ])
    expect(sessionChanges(snapshot)).toEqual([{ path: 'a.txt', operation: 'write' }])
  })

  it('returns nothing without a chat view or with an empty timeline', () => {
    expect(sessionChanges({ views: { get: () => undefined }, activeTargets: new Set() } as never)).toEqual([])
    expect(sessionChanges(conversationOf([]))).toEqual([])
  })

  it('skips turns that published no deliverables', () => {
    const snapshot = conversationOf([
      turnLocation(1),
      turnLocation(2, [{ path: 'a.txt', operation: 'write' }]),
    ])
    expect(sessionChanges(snapshot)).toEqual([{ path: 'a.txt', operation: 'write' }])
  })
})

describe('SessionChangesPanel', () => {
  const changes = [
    { path: 'a.txt', operation: 'write' },
    { path: 'b.txt', operation: 'edit' },
  ] as const

  afterEach(cleanup)

  const headerName = new RegExp(t('title'))

  function renderPanel(overrides?: {
    accepted?: ReadonlySet<string>
    onAccept?: (path: string) => void
    onAcceptAll?: (paths: readonly string[]) => void
  }) {
    const accepted = overrides?.accepted ?? new Set<string>()
    const onAccept = overrides?.onAccept ?? vi.fn()
    const onAcceptAll = overrides?.onAcceptAll ?? vi.fn()
    return render(
      <SessionChangesPanel
        changes={changes}
        accepted={accepted}
        onAccept={onAccept}
        onAcceptAll={onAcceptAll}
        t={t}
      />,
    )
  }

  it('collapses by default, shows accept-all in the header, and lists changes once expanded', () => {
    renderPanel()
    expect(screen.getByTestId('session-changes')).toBeDefined()
    expect(screen.getByText(t('summary', { count: 2 }))).toBeDefined()
    expect(screen.getByText(t('acceptAll'))).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: headerName }))
    expect(screen.getByText('a.txt')).toBeDefined()
    expect(screen.getByText('b.txt')).toBeDefined()
  })

  it('accepts one file without touching the others', () => {
    const onAccept = vi.fn()
    renderPanel({ onAccept })
    fireEvent.click(screen.getByRole('button', { name: headerName }))

    const acceptButtons = screen.getAllByRole('button', { name: t('accept') })
    expect(acceptButtons).toHaveLength(2)
    fireEvent.click(acceptButtons[0]!)

    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onAccept).toHaveBeenCalledWith('a.txt')
  })

  it('drops accepted files from the visible list using the adapter-owned set', () => {
    const accepted = new Set(['a.txt'])
    const onAccept = vi.fn()
    renderPanel({ accepted, onAccept })
    fireEvent.click(screen.getByRole('button', { name: headerName }))

    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(screen.getByText('b.txt')).toBeDefined()
  })

  it('renders nothing when every change is in the accept set', () => {
    const accepted = new Set(['a.txt', 'b.txt'])
    renderPanel({ accepted })
    expect(screen.queryByTestId('session-changes')).toBeNull()
  })

  it('routes the bulk-accept button through the adapter-owned handler with pending paths', () => {
    const onAcceptAll = vi.fn()
    renderPanel({ onAcceptAll })
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(onAcceptAll).toHaveBeenCalledTimes(1)
    expect(onAcceptAll).toHaveBeenCalledWith(['a.txt', 'b.txt'])
  })
})

describe('SessionChangesDock', () => {
  afterEach(cleanup)

  function dockProps(snapshot: ConversationSnapshot) {
    const useConversation = <T,>(selector: (s: ConversationSnapshot) => T) => selector(snapshot)
    return { useConversation, t } as unknown as Parameters<typeof SessionChangesDock>[0]
  }

  it('keeps accepted files dismissed when the conversation adds a new turn', () => {
    // First turn: agent writes a.txt and b.txt.
    const before = conversationOf([
      turnLocation(1, [
        { path: 'a.txt', operation: 'write' },
        { path: 'b.txt', operation: 'write' },
      ]),
    ])
    const { rerender } = render(<SessionChangesDock {...dockProps(before)} />)
    expect(screen.getByText(t('summary', { count: 2 }))).toBeDefined()

    // Reader accepts a.txt (the bug scenario: a new request arrives before
    // the reader has had a chance to accept every prior file).
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('title')) }))
    const perFileAccepts = screen.getAllByRole('button', { name: t('accept') })
    fireEvent.click(perFileAccepts[0]!)
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(screen.getByText('b.txt')).toBeDefined()

    // New turn lands: the agent adds c.txt and re-edits b.txt. The dock must
    // still hide a.txt (it was accepted) and now show b.txt + c.txt; a
    // previous incarnation of the component would reset the accept set and
    // resurrect a.txt as if the reader had never accepted it.
    const after = conversationOf([
      turnLocation(1, [
        { path: 'a.txt', operation: 'write' },
        { path: 'b.txt', operation: 'write' },
      ]),
      turnLocation(2, [
        { path: 'b.txt', operation: 'edit' },
        { path: 'c.txt', operation: 'write' },
      ]),
    ])
    rerender(<SessionChangesDock {...dockProps(after)} />)
    expect(screen.getByText(t('summary', { count: 2 }))).toBeDefined()
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(screen.getByText('b.txt')).toBeDefined()
    expect(screen.getByText('c.txt')).toBeDefined()
  })
})
