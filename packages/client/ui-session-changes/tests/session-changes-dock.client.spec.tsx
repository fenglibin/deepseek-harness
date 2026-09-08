// @vitest-environment jsdom

/**
 * ui-session-changes browser half: the session-wide change folding over
 * per-turn deliverables (including path canonicalization), the dock's
 * collapse/expand + accept + open behavior, the adapter-owned accept set's
 * survival across a new request, and the registration's injected opener.
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
  canonicalMutationPath, displayPath, SessionChangesDock, SessionChangesPanel, sessionChanges,
  type ProducedChange, type SessionChangesInjected,
} from '../src/client/SessionChangesDock.tsx'
import { zh } from '../src/client/locales.ts'
import { apply } from '../src/client/index.ts'
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

describe('canonicalMutationPath', () => {
  it('resolves a Workspace-relative path against the Session cwd', () => {
    expect(canonicalMutationPath('src/a.ts', '/proj')).toBe('/proj/src/a.ts')
  })

  it('leaves an absolute path absolute and collapses its dot segments', () => {
    expect(canonicalMutationPath('/proj/lib/../src//a.ts', '/proj')).toBe('/proj/src/a.ts')
  })

  it('unifies backslashes into forward slashes', () => {
    expect(canonicalMutationPath('src\\a.ts', '/proj')).toBe('/proj/src/a.ts')
    expect(canonicalMutationPath('C:\\proj\\src\\a.ts', '/proj')).toBe('C:/proj/src/a.ts')
  })

  it('cancels a .. segment only against a segment that can be cancelled', () => {
    expect(canonicalMutationPath('lib/../src/a.ts', '/proj')).toBe('/proj/src/a.ts')
    // Past the root there is nothing left to cancel, so the segment survives.
    expect(canonicalMutationPath('../../a.ts', '/proj')).toBe('/../a.ts')
    expect(canonicalMutationPath('../../../a.ts', '/proj')).toBe('/../../a.ts')
  })

  it('keeps a relative path relative without a Workspace root', () => {
    expect(canonicalMutationPath('src/a.ts', undefined)).toBe('src/a.ts')
  })
})

describe('displayPath', () => {
  it('drops the Workspace root from a path inside it', () => {
    expect(displayPath('/proj/src/a.ts', '/proj')).toBe('src/a.ts')
    expect(displayPath('/proj/src/a.ts', '/proj/')).toBe('src/a.ts')
  })

  it('keeps the absolute spelling of a path outside the Workspace', () => {
    expect(displayPath('/other/src/a.ts', '/proj')).toBe('/other/src/a.ts')
    expect(displayPath('/projx/a.ts', '/proj')).toBe('/projx/a.ts')
  })

  it('keeps the path as it is without a Workspace root', () => {
    expect(displayPath('src/a.ts', undefined)).toBe('src/a.ts')
    expect(displayPath('/proj/a.ts', '')).toBe('/proj/a.ts')
  })
})

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

  it('folds two spellings of one file into the canonical entry', () => {
    const snapshot = conversationOf([
      turnLocation(1, [{ path: 'src/a.ts', operation: 'write' }]),
      turnLocation(2, [{ path: '/proj/src/a.ts', operation: 'edit' }]),
    ])
    expect(sessionChanges(snapshot, '/proj')).toEqual([{ path: '/proj/src/a.ts', operation: 'write' }])
  })

  it('folds separator and dot-segment variants of one file into one entry', () => {
    const snapshot = conversationOf([
      turnLocation(1, [{ path: 'src\\a.ts', operation: 'write' }]),
      turnLocation(2, [{ path: './src//a.ts', operation: 'edit' }]),
    ])
    expect(sessionChanges(snapshot, '/proj')).toEqual([{ path: '/proj/src/a.ts', operation: 'write' }])
  })

  it('keeps same-named files from different directories apart', () => {
    const snapshot = conversationOf([
      turnLocation(1, [
        { path: '/proj/src/a.ts', operation: 'write' },
        { path: '/proj/lib/a.ts', operation: 'write' },
      ]),
    ])
    expect(sessionChanges(snapshot, '/proj')).toEqual([
      { path: '/proj/src/a.ts', operation: 'write' },
      { path: '/proj/lib/a.ts', operation: 'write' },
    ])
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
    { path: '/proj/src/a.ts', operation: 'write' },
    { path: '/proj/lib/b.ts', operation: 'edit' },
  ] as const

  afterEach(cleanup)

  const headerName = new RegExp(t('title'))
  const rowName = (path: string): RegExp => new RegExp(t('open', { name: path }))

  function renderPanel(overrides?: {
    accepted?: ReadonlySet<string>
    onAccept?: (path: string) => void
    onAcceptAll?: (paths: readonly string[]) => void
    openFile?: (path: string) => Promise<void>
    cwd?: string
  }) {
    const accepted = overrides?.accepted ?? new Set<string>()
    const onAccept = overrides?.onAccept ?? vi.fn()
    const onAcceptAll = overrides?.onAcceptAll ?? vi.fn()
    const openFile = overrides?.openFile ?? vi.fn<() => Promise<void>>(() => Promise.resolve())
    return {
      onAccept,
      onAcceptAll,
      openFile,
      ...render(
        <SessionChangesPanel
          changes={changes}
          accepted={accepted}
          onAccept={onAccept}
          onAcceptAll={onAcceptAll}
          openFile={openFile}
          cwd={overrides?.cwd ?? '/proj'}
          t={t}
        />,
      ),
    }
  }

  it('collapses by default, shows accept-all in the header, and lists changes once expanded', () => {
    renderPanel()
    expect(screen.getByTestId('session-changes')).toBeDefined()
    expect(screen.getByText(t('summary', { count: 2 }))).toBeDefined()
    expect(screen.getByText(t('acceptAll'))).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: headerName }))
    expect(screen.getByText('a.ts')).toBeDefined()
    expect(screen.getByText('b.ts')).toBeDefined()
  })

  it('shows every row with its directory, not just the file name', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: headerName }))
    expect(screen.getByText('src/')).toBeDefined()
    expect(screen.getByText('lib/')).toBeDefined()
    expect(screen.getByRole('button', { name: rowName('src/a.ts') })).toBeDefined()
    expect(screen.getByRole('button', { name: rowName('lib/b.ts') })).toBeDefined()
  })

  it('keeps the Workspace-relative row but the absolute path as its hover text', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: headerName }))
    expect(screen.getByTitle('/proj/src/a.ts')).toBeDefined()
  })

  it('shows a file outside the Workspace with its absolute path', () => {
    renderPanel({ cwd: '/elsewhere' })
    fireEvent.click(screen.getByRole('button', { name: headerName }))
    expect(screen.getByText('/proj/src/')).toBeDefined()
    expect(screen.getByRole('button', { name: rowName('/proj/src/a.ts') })).toBeDefined()
  })

  it('opens the clicked file through the injected opener', () => {
    const openFile = vi.fn<() => Promise<void>>(() => Promise.resolve())
    renderPanel({ openFile })
    fireEvent.click(screen.getByRole('button', { name: headerName }))
    fireEvent.click(screen.getByRole('button', { name: rowName('src/a.ts') }))
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(openFile).toHaveBeenCalledWith('/proj/src/a.ts')
  })

  it('reports a refused open on the strip and clears it on the next success', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('xdg-open is not available'))
      .mockResolvedValueOnce(undefined)
    renderPanel({ openFile })
    fireEvent.click(screen.getByRole('button', { name: headerName }))
    fireEvent.click(screen.getByRole('button', { name: rowName('src/a.ts') }))

    await vi.waitFor(() => {
      expect(screen.getByText(t('openFailed', { message: 'xdg-open is not available' }))).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: rowName('lib/b.ts') }))
    await vi.waitFor(() => {
      expect(screen.queryByText(t('openFailed', { message: 'xdg-open is not available' }))).toBeNull()
    })
  })

  it('reports a non-Error refusal through its string form', async () => {
    const openFile = vi.fn<() => Promise<void>>().mockRejectedValueOnce('no opener')
    renderPanel({ openFile })
    fireEvent.click(screen.getByRole('button', { name: headerName }))
    fireEvent.click(screen.getByRole('button', { name: rowName('src/a.ts') }))
    await vi.waitFor(() => {
      expect(screen.getByText(t('openFailed', { message: 'no opener' }))).toBeDefined()
    })
  })

  it('accepts one file without touching the others', () => {
    const onAccept = vi.fn()
    renderPanel({ onAccept })
    fireEvent.click(screen.getByRole('button', { name: headerName }))

    const acceptButtons = screen.getAllByRole('button', { name: t('accept') })
    expect(acceptButtons).toHaveLength(2)
    fireEvent.click(acceptButtons[0]!)

    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onAccept).toHaveBeenCalledWith('/proj/src/a.ts')
  })

  it('drops accepted files from the visible list using the adapter-owned set', () => {
    const accepted = new Set(['/proj/src/a.ts'])
    const onAccept = vi.fn()
    renderPanel({ accepted, onAccept })
    fireEvent.click(screen.getByRole('button', { name: headerName }))

    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.getByText('b.ts')).toBeDefined()
  })

  it('renders nothing when every change is in the accept set', () => {
    const accepted = new Set(['/proj/src/a.ts', '/proj/lib/b.ts'])
    renderPanel({ accepted })
    expect(screen.queryByTestId('session-changes')).toBeNull()
  })

  it('routes the bulk-accept button through the adapter-owned handler with pending paths', () => {
    const onAcceptAll = vi.fn()
    renderPanel({ onAcceptAll })
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(onAcceptAll).toHaveBeenCalledTimes(1)
    expect(onAcceptAll).toHaveBeenCalledWith(['/proj/src/a.ts', '/proj/lib/b.ts'])
  })
})

describe('SessionChangesDock', () => {
  afterEach(cleanup)

  function dockProps(snapshot: ConversationSnapshot) {
    const useConversation = <T,>(selector: (s: ConversationSnapshot) => T) => selector(snapshot)
    return {
      useConversation,
      cwd: '/proj',
      openFile: () => Promise.resolve(),
      t,
    } as unknown as Parameters<typeof SessionChangesDock>[0]
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

  it('folds the turn paths through the injected Workspace root and lists them relative to it', () => {
    const snapshot = conversationOf([
      turnLocation(1, [{ path: 'src/a.ts', operation: 'write' }]),
      turnLocation(2, [{ path: '/proj/src/a.ts', operation: 'edit' }]),
    ])
    render(<SessionChangesDock {...dockProps(snapshot)} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('title')) }))
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
    expect(screen.getByText('src/')).toBeDefined()
    expect(screen.getByTitle('/proj/src/a.ts')).toBeDefined()
  })

  it('lists a bare file name when the Session has no Workspace root', () => {
    const snapshot = conversationOf([turnLocation(1, [{ path: 'a.txt', operation: 'write' }])])
    render(<SessionChangesDock {...dockProps(snapshot)} cwd={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('title')) }))
    expect(screen.getByText('a.txt')).toBeDefined()
    expect(screen.queryByText('/')).toBeNull()
  })

  it('routes the bulk accept through the adapter-owned set', () => {
    const snapshot = conversationOf([
      turnLocation(1, [
        { path: 'a.txt', operation: 'write' },
        { path: 'b.txt', operation: 'write' },
      ]),
    ])
    render(<SessionChangesDock {...dockProps(snapshot)} cwd={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(screen.queryByTestId('session-changes')).toBeNull()
  })
})

describe('dock registration', () => {
  /** The Host opener's settled value: acceptance, or a refusal carrying its reason. */
  type OpenResult = { ok: true; value: { opened: boolean } } | { ok: false; error: { message: string } }

  it('injects the Workspace root and an opener that forwards the listed path', async () => {
    const openWorkspacePath = vi.fn<(request: { path: string }) => Promise<OpenResult>>(
      () => Promise.resolve({ ok: true, value: { opened: true } }),
    )
    const register = vi.fn((_options: unknown, _component: unknown) => () => undefined)
    const slotsInject = vi.fn((_name: string, callback: () => () => void) => callback())
    const localeRegister = vi.fn()
    apply({
      effect: (body: () => void) => { body() },
      locale: { register: localeRegister },
      slots: { inject: slotsInject, register },
      sessions: { list: { getSnapshot: () => ({ byId: { 's1': { cwd: '/proj' } } }) } },
      remote: { session: { openWorkspacePath } },
    } as never)

    expect(localeRegister).toHaveBeenCalledWith('session-changes', { zh })
    expect(slotsInject).toHaveBeenCalledWith('conversation.input.dock', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-changes', order: -10, locale: 'session-changes' }),
      SessionChangesDock,
    )

    const options = register.mock.calls[0]![0] as { inject: (sessionId: string) => SessionChangesInjected }
    const injected = options.inject('s1')
    expect(injected.cwd).toBe('/proj')

    await injected.openFile('/proj/src/a.ts')
    expect(openWorkspacePath).toHaveBeenCalledWith({ path: '/proj/src/a.ts' })

    openWorkspacePath.mockResolvedValueOnce({ ok: false, error: { message: 'xdg-open is not available' } })
    await expect(injected.openFile('/proj/src/a.ts')).rejects.toThrow('xdg-open is not available')
  })
})
