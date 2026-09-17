// @vitest-environment jsdom

/**
 * ui-session-changes browser half: the session-wide change folding over
 * per-turn deliverables (including path canonicalization and seq bounds), the
 * accept rule that returns a re-mutated file to the list, the dock's
 * collapse/expand + accept + open behavior, the projection-first source with
 * its window fallback, and the registration's injected opener.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type {
  ConversationLocationDataStore, ConversationSnapshot, ConversationTurnDataMap, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DeliverablesTurnData } from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type { ChangedFilesProjection } from '@deepseek-ai/dsh-file-changes/client'
import { makeTranslate, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  canonicalMutationPath, displayPath, isPendingChange, pendingChanges, SessionChangesDock,
  SessionChangesPanel, sessionChanges,
  type SessionChange, type SessionChangesInjected,
} from '../src/client/SessionChangesDock.tsx'
import { createAcceptedChangesStore, type AcceptedChanges } from '../src/client/accept-store.ts'
import { zh } from '../src/client/locales.ts'
import { apply } from '../src/client/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'
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

/** One turn's produced change, spelled as the turn data records it. */
interface Produced {
  readonly path: string
  readonly operation: 'write' | 'edit'
  /** Seq the mutation's result carried; defaults to the entry's position. */
  readonly seq?: number
}

function turnLocation(turn: number, changes?: readonly Produced[]): TurnLocation {
  const data = new TestTurnDataStore()
  if (changes !== undefined) {
    const deliverables: DeliverablesTurnData = {
      produced: changes.map((change, index) => ({
        seq: change.seq ?? index + 1,
        path: change.path,
        operation: change.operation,
      })),
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

/** One projected whole-log change, as the host unit serves it. */
function projected(path: string, firstSeq: number, lastSeq = firstSeq): SessionChange {
  return { path, operation: 'write', firstSeq, lastSeq }
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
        { path: 'a.txt', operation: 'write', seq: 10 },
        { path: 'b.txt', operation: 'edit', seq: 11 },
      ]),
      turnLocation(2, [
        { path: 'b.txt', operation: 'edit', seq: 20 },
        { path: 'c.txt', operation: 'write', seq: 21 },
      ]),
    ])
    expect(sessionChanges(snapshot)).toEqual([
      { path: 'a.txt', operation: 'write', firstSeq: 10, lastSeq: 10 },
      { path: 'b.txt', operation: 'edit', firstSeq: 11, lastSeq: 20 },
      { path: 'c.txt', operation: 'write', firstSeq: 21, lastSeq: 21 },
    ])
  })

  it('keeps the earliest operation kind for a file mutated across turns', () => {
    const snapshot = conversationOf([
      turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }]),
      turnLocation(2, [{ path: 'a.txt', operation: 'edit', seq: 20 }]),
    ])
    expect(sessionChanges(snapshot)).toEqual([
      { path: 'a.txt', operation: 'write', firstSeq: 10, lastSeq: 20 },
    ])
  })

  it('folds two spellings of one file into the canonical entry', () => {
    const snapshot = conversationOf([
      turnLocation(1, [{ path: 'src/a.ts', operation: 'write', seq: 10 }]),
      turnLocation(2, [{ path: '/proj/src/a.ts', operation: 'edit', seq: 20 }]),
    ])
    expect(sessionChanges(snapshot, '/proj')).toEqual([
      { path: '/proj/src/a.ts', operation: 'write', firstSeq: 10, lastSeq: 20 },
    ])
  })

  it('folds by seq, not by arrival order', () => {
    // An older history page prepended later can leave the turns Map ahead of
    // chronological order. The fold must still take the operation and firstSeq
    // from the EARLIEST mutation and lastSeq from the LATEST — otherwise
    // lastSeq could move backwards and hide a change the reader never accepted.
    const snapshot = conversationOf([
      turnLocation(2, [{ path: 'a.txt', operation: 'edit', seq: 30 }]),
      turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }]),
    ])
    expect(sessionChanges(snapshot)).toEqual([
      { path: 'a.txt', operation: 'write', firstSeq: 10, lastSeq: 30 },
    ])
  })

  it('folds separator and dot-segment variants of one file into one entry', () => {
    const snapshot = conversationOf([
      turnLocation(1, [{ path: 'src\\a.ts', operation: 'write', seq: 10 }]),
      turnLocation(2, [{ path: './src//a.ts', operation: 'edit', seq: 20 }]),
    ])
    expect(sessionChanges(snapshot, '/proj')).toEqual([
      { path: '/proj/src/a.ts', operation: 'write', firstSeq: 10, lastSeq: 20 },
    ])
  })

  it('keeps same-named files from different directories apart', () => {
    const snapshot = conversationOf([
      turnLocation(1, [
        { path: '/proj/src/a.ts', operation: 'write', seq: 10 },
        { path: '/proj/lib/a.ts', operation: 'write', seq: 11 },
      ]),
    ])
    expect(sessionChanges(snapshot, '/proj')).toEqual([
      { path: '/proj/src/a.ts', operation: 'write', firstSeq: 10, lastSeq: 10 },
      { path: '/proj/lib/a.ts', operation: 'write', firstSeq: 11, lastSeq: 11 },
    ])
  })

  it('returns nothing without a chat view or with an empty timeline', () => {
    expect(sessionChanges({ views: { get: () => undefined }, activeTargets: new Set() } as never)).toEqual([])
    expect(sessionChanges(conversationOf([]))).toEqual([])
  })

  it('skips turns that published no deliverables', () => {
    const snapshot = conversationOf([
      turnLocation(1),
      turnLocation(2, [{ path: 'a.txt', operation: 'write', seq: 10 }]),
    ])
    expect(sessionChanges(snapshot)).toEqual([
      { path: 'a.txt', operation: 'write', firstSeq: 10, lastSeq: 10 },
    ])
  })
})

describe('pendingChanges', () => {
  const a = projected('/proj/a.txt', 10, 10)
  const b = projected('/proj/b.txt', 20, 20)

  it('treats every change as pending before any accept', () => {
    expect(pendingChanges([a, b], {})).toEqual([a, b])
  })

  it('drops a change accepted at its current seq', () => {
    expect(pendingChanges([a, b], { '/proj/a.txt': 10 })).toEqual([b])
  })

  it('returns a file whose latest mutation is newer than its accept', () => {
    // The reader accepted a.txt at seq 10; the agent then mutated it again at 30.
    const reMutated = projected('/proj/a.txt', 10, 30)
    expect(pendingChanges([reMutated], { '/proj/a.txt': 10 })).toEqual([reMutated])
  })

  it('keeps a file hidden while no newer mutation lands', () => {
    expect(pendingChanges([a], { '/proj/a.txt': 10 })).toEqual([])
  })

  it('reports one row as pending by the same comparison the list uses', () => {
    expect(isPendingChange(a, {})).toBe(true)
    expect(isPendingChange(a, { '/proj/a.txt': 10 })).toBe(false)
    // The accept covered seq 10, but this row now carries seq 30.
    expect(isPendingChange(projected('/proj/a.txt', 10, 30), { '/proj/a.txt': 10 })).toBe(true)
  })
})

describe('SessionChangesPanel', () => {
  const changes = [
    { path: '/proj/src/a.ts', operation: 'write', firstSeq: 1, lastSeq: 1 },
    { path: '/proj/lib/b.ts', operation: 'edit', firstSeq: 2, lastSeq: 2 },
  ] as const

  afterEach(cleanup)

  const headerName = new RegExp(t('title'))
  const rowName = (path: string): RegExp => new RegExp(t('open', { name: path }))

  function renderPanel(overrides?: {
    accepted?: AcceptedChanges
    onAccept?: (change: SessionChange) => void
    onAcceptAll?: (changes: readonly SessionChange[]) => void
    openFile?: (path: string) => Promise<void>
    cwd?: string
  }) {
    const accepted = overrides?.accepted ?? {}
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
          // This suite covers the accept and open behavior; the revision
          // controls and their per-row gating live in revision-diff.client.spec.
          hasRevision={() => false}
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
    expect(onAccept).toHaveBeenCalledWith(changes[0])
  })

  it('drops accepted files from the visible list using the accept record', () => {
    const accepted = { '/proj/src/a.ts': 1 }
    const onAccept = vi.fn()
    renderPanel({ accepted, onAccept })
    fireEvent.click(screen.getByRole('button', { name: headerName }))

    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.getByText('b.ts')).toBeDefined()
  })

  it('keeps the strip reachable once every change is accepted', () => {
    // The all-view entry must not vanish with the pending rows: a reader who
    // accepted everything still needs a way back to the files.
    const accepted = { '/proj/src/a.ts': 1, '/proj/lib/b.ts': 2 }
    renderPanel({ accepted })
    expect(screen.getByTestId('session-changes')).toBeDefined()
    expect(screen.getByText(t('summary', { count: 0 }))).toBeDefined()
    // Nothing is pending, so the bulk action has no subject left.
    expect(screen.queryByRole('button', { name: t('acceptAll') })).toBeNull()
  })

  it('lists every change, accepted ones included, in the all view', () => {
    renderPanel({ accepted: { '/proj/src/a.ts': 1 } })
    fireEvent.click(screen.getByRole('button', { name: headerName }))
    fireEvent.click(screen.getByRole('tab', { name: t('view.all') }))

    expect(screen.getByText(t('summaryAll', { count: 2 }))).toBeDefined()
    expect(screen.getByText('a.ts')).toBeDefined()
    expect(screen.getByText('b.ts')).toBeDefined()
    // The accepted row keeps its place but offers no second accept.
    expect(screen.getByText(t('accepted'))).toBeDefined()
    expect(screen.getAllByRole('button', { name: t('accept') })).toHaveLength(1)
  })

  it('lists an accepted path in BOTH views once it changes again', () => {
    // The overlap the two readings exist to show: the reader accepted a.ts at
    // seq 1, then the agent changed it again at seq 9. It is pending once more
    // AND still carries its accept record, so each view lists it exactly once.
    const reMutated = [
      { path: '/proj/src/a.ts', operation: 'write', firstSeq: 1, lastSeq: 9 },
      { path: '/proj/lib/b.ts', operation: 'edit', firstSeq: 2, lastSeq: 2 },
    ] as const
    render(
      <SessionChangesPanel
        changes={reMutated}
        accepted={{ '/proj/src/a.ts': 1 }}
        onAccept={vi.fn()}
        onAcceptAll={vi.fn()}
        openFile={() => Promise.resolve()}
        cwd="/proj"
        hasRevision={() => false}
        t={t}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: headerName }))
    expect(screen.getByText(t('summary', { count: 2 }))).toBeDefined()
    expect(screen.getByText('a.ts')).toBeDefined()

    fireEvent.click(screen.getByRole('tab', { name: t('view.all') }))
    expect(screen.getByText(t('summaryAll', { count: 2 }))).toBeDefined()
    // One row for the path, so the two views cannot disagree on its count.
    expect(screen.getAllByText('a.ts')).toHaveLength(1)
  })

  it('drops the path from the pending view on a second accept while the all view keeps one row', () => {
    const reMutated = [
      { path: '/proj/src/a.ts', operation: 'write', firstSeq: 1, lastSeq: 9 },
    ] as const
    const { rerender } = render(
      <SessionChangesPanel
        changes={reMutated}
        accepted={{ '/proj/src/a.ts': 1 }}
        onAccept={vi.fn()}
        onAcceptAll={vi.fn()}
        openFile={() => Promise.resolve()}
        cwd="/proj"
        hasRevision={() => false}
        t={t}
      />,
    )
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()

    // Second accept at the seq now on screen: pending empties, all keeps one.
    rerender(
      <SessionChangesPanel
        changes={reMutated}
        accepted={{ '/proj/src/a.ts': 9 }}
        onAccept={vi.fn()}
        onAcceptAll={vi.fn()}
        openFile={() => Promise.resolve()}
        cwd="/proj"
        hasRevision={() => false}
        t={t}
      />,
    )
    expect(screen.getByText(t('summary', { count: 0 }))).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: headerName }))
    fireEvent.click(screen.getByRole('tab', { name: t('view.all') }))
    expect(screen.getAllByText('a.ts')).toHaveLength(1)
    expect(screen.getByText(t('accepted'))).toBeDefined()
  })

  it('renders nothing when the Session never changed a file', () => {
    render(
      <SessionChangesPanel
        changes={[]}
        accepted={{}}
        onAccept={vi.fn()}
        onAcceptAll={vi.fn()}
        openFile={() => Promise.resolve()}
        cwd="/proj"
        hasRevision={() => false}
        t={t}
      />,
    )
    expect(screen.queryByTestId('session-changes')).toBeNull()
  })

  it('shows a file again once its latest mutation is newer than its accept', () => {
    // The same path, now carrying a later lastSeq: the accept no longer covers it.
    const reMutated = [{ path: '/proj/src/a.ts', operation: 'write', firstSeq: 1, lastSeq: 9 }] as const
    render(
      <SessionChangesPanel
        changes={reMutated}
        accepted={{ '/proj/src/a.ts': 1 }}
        onAccept={vi.fn()}
        onAcceptAll={vi.fn()}
        openFile={() => Promise.resolve()}
        cwd="/proj"
        hasRevision={() => false}
        t={t}
      />,
    )
    expect(screen.getByTestId('session-changes')).toBeDefined()
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
  })

  it('routes the bulk-accept button through the panel handler with pending changes', () => {
    const onAcceptAll = vi.fn()
    renderPanel({ onAcceptAll })
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(onAcceptAll).toHaveBeenCalledTimes(1)
    expect(onAcceptAll).toHaveBeenCalledWith(changes)
  })
})

describe('SessionChangesDock', () => {
  // The accept store persists, so a leftover value from an earlier test would
  // seed the next one's instance — the suite owns the storage it writes.
  beforeEach(() => { localStorage.clear() })
  afterEach(cleanup)

  /**
   * One live accept-store instance bound to the hook/actions props shape the
   * slot machinery supplies. Tests drive the real store rather than a stub, so
   * the persistence key and the action set are exercised as shipped, and the
   * hook comes from the framework's own snapshot binding so a write re-renders.
   */
  function acceptSeat(sessionId = 's1', handle = createAcceptedChangesStore()) {
    const instance = handle.create(sessionId)
    return { useStore: bindSnapshotSelector(instance), actions: instance.actions, instance, handle }
  }

  /** Dock props reading the given projection; omit it to exercise the fallback. */
  function dockProps(
    snapshot: ConversationSnapshot,
    projected?: ChangedFilesProjection,
    seat = acceptSeat(),
  ) {
    const useConversation = <T,>(selector: (s: ConversationSnapshot) => T) => selector(snapshot)
    const useProjection = () => projected
    return {
      useConversation,
      useProjection,
      useStore: seat.useStore,
      actions: seat.actions,
      cwd: '/proj',
      openFile: () => Promise.resolve(),
      t,
    } as unknown as Parameters<typeof SessionChangesDock>[0]
  }

  it('keeps accepted files dismissed when the conversation adds a new turn', () => {
    // First turn: agent writes a.txt and b.txt.
    const before = conversationOf([
      turnLocation(1, [
        { path: 'a.txt', operation: 'write', seq: 10 },
        { path: 'b.txt', operation: 'write', seq: 11 },
      ]),
    ])
    const seat = acceptSeat()
    const { rerender } = render(<SessionChangesDock {...dockProps(before, undefined, seat)} />)
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
    // still hide a.txt (it was accepted and not touched again) and now show
    // b.txt + c.txt; a previous incarnation of the component would reset the
    // accept set and resurrect a.txt as if the reader had never accepted it.
    const after = conversationOf([
      turnLocation(1, [
        { path: 'a.txt', operation: 'write', seq: 10 },
        { path: 'b.txt', operation: 'write', seq: 11 },
      ]),
      turnLocation(2, [
        { path: 'b.txt', operation: 'edit', seq: 20 },
        { path: 'c.txt', operation: 'write', seq: 21 },
      ]),
    ])
    rerender(<SessionChangesDock {...dockProps(after, undefined, seat)} />)
    expect(screen.getByText(t('summary', { count: 2 }))).toBeDefined()
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(screen.getByText('b.txt')).toBeDefined()
    expect(screen.getByText('c.txt')).toBeDefined()
  })

  it('returns an accepted file to the list once it is mutated again', () => {
    const before = conversationOf([turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }])])
    const seat = acceptSeat()
    const { rerender } = render(<SessionChangesDock {...dockProps(before, undefined, seat)} />)
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(screen.getByText(t('summary', { count: 0 }))).toBeDefined()

    // The agent edits a.txt again: the accept covered seq 10, the new change is 20.
    const after = conversationOf([
      turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }]),
      turnLocation(2, [{ path: 'a.txt', operation: 'edit', seq: 20 }]),
    ])
    rerender(<SessionChangesDock {...dockProps(after, undefined, seat)} />)
    expect(screen.getByTestId('session-changes')).toBeDefined()
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
  })

  it('prefers the whole-log projection over the loaded window', () => {
    // The window holds one turn; the projection knows about two files, one of
    // which the window never saw — the projection wins.
    const snapshot = conversationOf([turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }])])
    const projected: ChangedFilesProjection = {
      files: [
        { path: '/proj/a.txt', operation: 'write', firstSeq: 10, lastSeq: 10 },
        { path: '/proj/earlier.txt', operation: 'write', firstSeq: 2, lastSeq: 2 },
      ],
    }
    render(<SessionChangesDock {...dockProps(snapshot, projected)} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('title')) }))
    expect(screen.getByText(t('summary', { count: 2 }))).toBeDefined()
    expect(screen.getByText('earlier.txt')).toBeDefined()
  })

  it('falls back to the window fold when the projection is absent', () => {
    const snapshot = conversationOf([turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }])])
    render(<SessionChangesDock {...dockProps(snapshot)} />)
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
  })

  it('folds the turn paths through the injected Workspace root and lists them relative to it', () => {
    const snapshot = conversationOf([
      turnLocation(1, [{ path: 'src/a.ts', operation: 'write', seq: 10 }]),
      turnLocation(2, [{ path: '/proj/src/a.ts', operation: 'edit', seq: 20 }]),
    ])
    render(<SessionChangesDock {...dockProps(snapshot)} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('title')) }))
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
    expect(screen.getByText('src/')).toBeDefined()
    expect(screen.getByTitle('/proj/src/a.ts')).toBeDefined()
  })

  it('lists a bare file name when the Session has no Workspace root', () => {
    const snapshot = conversationOf([turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }])])
    render(<SessionChangesDock {...dockProps(snapshot)} cwd={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('title')) }))
    expect(screen.getByText('a.txt')).toBeDefined()
    expect(screen.queryByText('/')).toBeNull()
  })

  it('accepts without asking the Host to change anything on disk', () => {
    // The dock's opener is the only channel it has to the Host; accepting must
    // not use it (or any other), because accept is a surface-only dismissal.
    const openFile = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const snapshot = conversationOf([turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }])])
    render(<SessionChangesDock {...dockProps(snapshot)} openFile={openFile} />)
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(openFile).not.toHaveBeenCalled()
  })

  it('keeps every accept when the dock remounts', () => {
    // The accept record lives in the session-scoped store, so a fresh mount of
    // the same Session reuses it. A component-local set would resurrect every
    // accepted file here — the reported defect.
    const snapshot = conversationOf([turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }])])
    const seat = acceptSeat()
    const first = render(<SessionChangesDock {...dockProps(snapshot, undefined, seat)} />)
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(screen.getByText(t('summary', { count: 0 }))).toBeDefined()

    first.unmount()
    render(<SessionChangesDock {...dockProps(snapshot, undefined, seat)} />)
    expect(screen.getByTestId('session-changes')).toBeDefined()
    expect(screen.getByText(t('summary', { count: 0 }))).toBeDefined()
  })

  it('keeps the accept record across a page reload', () => {
    // A reload discards the instance but keeps the persisted value, so a store
    // created fresh from the same handle and Session still knows the accept.
    const snapshot = conversationOf([turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }])])
    const handle = createAcceptedChangesStore()
    const first = render(<SessionChangesDock {...dockProps(snapshot, undefined, acceptSeat('s1', handle))} />)
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    first.unmount()

    render(<SessionChangesDock {...dockProps(snapshot, undefined, acceptSeat('s1', handle))} />)
    expect(screen.getByText(t('summary', { count: 0 }))).toBeDefined()
  })

  it('keeps Sessions independent', () => {
    const snapshot = conversationOf([turnLocation(1, [{ path: 'a.txt', operation: 'write', seq: 10 }])])
    const handle = createAcceptedChangesStore()
    const first = render(<SessionChangesDock {...dockProps(snapshot, undefined, acceptSeat('session-a', handle))} />)
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(screen.getByText(t('summary', { count: 0 }))).toBeDefined()
    first.unmount()

    // A different Session gets its own instance: accepting there cannot leak.
    render(<SessionChangesDock {...dockProps(snapshot, undefined, acceptSeat('session-b', handle))} />)
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
  })

  it('routes the bulk accept through the store actions', () => {
    const snapshot = conversationOf([
      turnLocation(1, [
        { path: 'a.txt', operation: 'write', seq: 10 },
        { path: 'b.txt', operation: 'write', seq: 11 },
      ]),
    ])
    const seat = acceptSeat()
    render(<SessionChangesDock {...dockProps(snapshot, undefined, seat)} />)
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(seat.instance.getSnapshot()).toEqual({ '/proj/a.txt': 10, '/proj/b.txt': 11 })
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
      // No viewer composed: the desktop opener is the only way to open a file.
      get: () => undefined,
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

  it('opens the listed path in the viewer instead of the desktop when one is composed', () => {
    const register = vi.fn()
    const open = vi.fn(() => ({ kind: 'opened' as const }))
    const openWorkspacePath = vi.fn()
    apply({
      effect: (body: () => void) => { body() },
      locale: { register: vi.fn() },
      slots: { inject: (_name: string, callback: () => () => void) => callback(), register },
      sessions: { list: { getSnapshot: () => ({ byId: { 's1': { cwd: '/proj' } } }) } },
      remote: { session: { openWorkspacePath } },
      get: (name: string) => (name === 'fileViewer' ? { open } : undefined),
    } as never)

    const options = register.mock.calls[0]![0] as { inject: (sessionId: string) => SessionChangesInjected }
    void options.inject('s1').openFile('src/a.ts')

    // The viewer resolves the session's Workspace itself, so the row hands it
    // the session identity and the path as listed — never a resolved path.
    expect(open).toHaveBeenCalledWith({ sessionId: 's1', path: 'src/a.ts' })
    expect(openWorkspacePath).not.toHaveBeenCalled()
  })
})

describe('package shell', () => {
  it('the node half is an inert host plugin body', async () => {
    // The empty apply is what makes this plugin appear in the host cordis.yml;
    // the browser half ships through the package's `./client` export.
    const { apply: applyNodeHalf } = await import('../src/index.ts')
    expect(applyNodeHalf).toBeTypeOf('function')
    // The inert body must run without touching a context it was not given.
    applyNodeHalf()
  })

  it('the invariant companion registers ownership', async () => {
    const registered: string[] = []
    let installer: (() => void) | undefined
    const ctx = new Context()
    ctx.provide('invariants')
    ctx.set('invariants', {
      register: (pkg: string, install: () => void) => {
        registered.push(pkg)
        installer = install
        return () => {}
      },
    } as never)
    const dispose = await applyInvariant(ctx)
    expect(registered).toEqual(['@deepseek-ai/dsh-client-ui-session-changes'])
    expect(dispose).toBeTypeOf('function')
    // This package declares no runtime invariant, so its installer is inert;
    // the registry still runs it, and it must stay a no-op.
    expect(installer?.()).toBeUndefined()
  })
})
