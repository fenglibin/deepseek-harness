// @vitest-environment jsdom

/**
 * ui-session-changes browser half: the session-wide change folding over
 * per-turn deliverables, and the dock's collapse/expand + accept behavior.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  ConversationLocationDataStore, ConversationSnapshot, ConversationTurnDataMap, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DeliverablesTurnData } from '@deepseek-ai/dsh-client-ui-deliverables/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  SessionChangesPanel, sessionChanges, type ProducedChange,
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

  function renderPanel() {
    return render(
      <SessionChangesPanel changes={changes} t={t} />,
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
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: headerName }))

    const acceptButtons = screen.getAllByRole('button', { name: t('accept') })
    expect(acceptButtons).toHaveLength(2)
    fireEvent.click(acceptButtons[0]!)

    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(screen.getByText('b.txt')).toBeDefined()
  })

  it('accepts all files from the collapsed header and hides the dock once empty', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))

    expect(screen.queryByTestId('session-changes')).toBeNull()
  })
})
