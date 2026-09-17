// @vitest-environment jsdom

/**
 * The dock's revision surface. The viewer moved OUT of the strip, so what the
 * dock owes is a request: these specs assert the controls appear only where the
 * Host recorded a revision, and that clicking one publishes the file rather than
 * growing a diff inline.
 *
 * The viewer itself is covered in revision-viewer.client.spec.tsx, and the
 * alignment model in revision-diff-model.spec.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionChangesDock, type SessionChange } from '../src/client/SessionChangesDock.tsx'
import { createAcceptedChangesStore } from '../src/client/accept-store.ts'
import { zh } from '../src/client/locales.ts'
import type { RevisionRemote } from '../src/client/revision-remote.ts'
import type { RevisionViewerRequest } from '../src/client/revision-viewer-request.ts'
import type {
  RevisionEntry, RevertFileResult,
} from '@deepseek-ai/dsh-api-session-file-revisions/types'
import '@deepseek-ai/dsh-client-ui-session-changes/client'

const t: Parameters<typeof SessionChangesDock>[0]['t'] = makeTranslate(zh, commonZh)

/** A blank conversation, so the dock exercises the projection path. */
const conversation = { views: { get: () => undefined } } as unknown as ConversationSnapshot

const CHANGE: SessionChange = {
  path: '/proj/a.txt', operation: 'write', firstSeq: 10, lastSeq: 10,
}

afterEach(() => { cleanup() })

/** One recorded revision entry, as the Host's `list` reports it. */
function entry(path: string): RevisionEntry {
  return { path, operation: 'write', origin: 'existing', added: 1, removed: 0, oversized: false }
}

/**
 * Dock props for one mount, capturing what the dock asked the viewer to show.
 *
 * The recorded set is stated once through `recorded` and overrides whatever
 * `revisions.list` says, so a spec never repeats the Host's path set inside a
 * verb. A spec that needs the set to change while mounted (a revert retiring a
 * path) builds its own props instead, since a captured array cannot move.
 */
function dockProps(options: {
  revisions?: RevisionRemote | undefined
  recorded?: readonly string[]
  files?: readonly SessionChange[]
} = {}) {
  const recorded = options.recorded ?? [CHANGE.path]
  const opened: RevisionViewerRequest[] = []
  const seat = createAcceptedChangesStore().create('s1')
  const revisions = options.revisions === undefined
    ? undefined
    : { ...options.revisions, list: async () => recorded.map(entry) }
  const props: Parameters<typeof SessionChangesDock>[0] = {
    useConversation: () => conversation,
    useProjection: () => ({ files: options.files ?? [CHANGE] }),
    useStore: bindSnapshotSelector(seat),
    actions: seat.actions,
    sessionId: 's1',
    cwd: '/proj',
    openFile: async () => {},
    revisions,
    openViewer: (request: RevisionViewerRequest) => { opened.push(request) },
    t,
  } as unknown as Parameters<typeof SessionChangesDock>[0]
  return { props, opened, seat }
}

/** The verbs a dock needs, with `list` supplied by {@link dockProps}. */
function verbs(overrides: Partial<RevisionRemote> = {}): RevisionRemote {
  return {
    list: async () => [],
    diff: async () => ({ path: CHANGE.path, origin: 'existing', baseline: null, endState: '', withheld: null }),
    revertAll: async () => [],
    ...overrides,
  }
}

/** Open the collapsed strip so its rows are reachable. */
function expand(): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['title']) }))
}

/**
 * Open the strip and wait for the Host's recorded set to land.
 *
 * The recorded set arrives from a Remote call, so the row's controls appear one
 * microtask after mount rather than with the first paint.
 * @returns the view-changes button, once the row offers it.
 */
async function expandWithRevision(): Promise<HTMLElement> {
  expand()
  return screen.findByRole('button', { name: zh['viewChanges'] })
}

describe('dock revision controls', () => {
  it('offers no view-diff or revert when revisions are absent', () => {
    render(<SessionChangesDock {...dockProps().props} />)
    expect(screen.queryByRole('button', { name: zh['viewChanges'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['revertAll'] })).toBeNull()
  })

  it('offers both controls when revisions are present', async () => {
    render(<SessionChangesDock {...dockProps({ revisions: verbs() }).props} />)
    expand()
    expect(await screen.findByRole('button', { name: zh['viewChanges'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['revertAll'] })).toBeTruthy()
  })

  it('publishes an open request instead of rendering a diff in the strip', async () => {
    // The point of moving the viewer out: no diff surface belongs to the strip,
    // so the dock's only move is to ask the overlay to show the file.
    const { props, opened } = dockProps({ revisions: verbs() })
    render(<SessionChangesDock {...props} />)
    fireEvent.click(await expandWithRevision())
    expect(opened).toEqual([{ sessionId: 's1', path: '/proj/a.txt', fileCount: 1 }])
    expect(screen.queryByTestId('revision-diff')).toBeNull()
  })

  it('offers no controls for a listed path the Host recorded no revision for', async () => {
    // The changed-file list is folded from the durable log while the revision
    // record lives on the Host's own side, so the two disagree for paths the
    // list knows and the record does not. A control there would promise an
    // action that cannot be answered.
    render(<SessionChangesDock {...dockProps({ revisions: verbs(), recorded: [] }).props} />)
    expand()
    await waitFor(() => {
      expect(screen.getByText(zh['view.pending'])).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: zh['viewChanges'] })).toBeNull()
  })

  it('offers no revert-all when the Host recorded nothing to revert', async () => {
    // The bulk control reverts what the Host RECORDED, not what the list shows.
    // Offering it while the recorded set is empty promises "reverted 0 files" —
    // the same false promise the per-row gating exists to remove.
    render(<SessionChangesDock {...dockProps({ revisions: verbs(), recorded: [] }).props} />)
    expand()
    await waitFor(() => {
      expect(screen.getByText(zh['view.pending'])).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: zh['revertAll'] })).toBeNull()
  })

  it('offers its controls for a file changed after the dock mounted', async () => {
    // The changed-file list grows live as the agent mutates files, while the
    // recorded set is a Remote read. A mount-only read would leave a newly
    // changed file without its controls until the reader reloaded the page.
    let recorded: string[] = []
    let files: readonly SessionChange[] = []
    const seat = createAcceptedChangesStore().create('s1')
    const props = {
      useConversation: () => conversation,
      useProjection: () => ({ files }),
      useStore: bindSnapshotSelector(seat),
      actions: seat.actions,
      sessionId: 's1',
      cwd: '/proj',
      openFile: async () => {},
      revisions: { ...verbs(), list: async () => recorded.map(entry) },
      openViewer: () => {},
      t,
    } as unknown as Parameters<typeof SessionChangesDock>[0]
    const { rerender } = render(<SessionChangesDock {...props} />)
    // Nothing changed yet, so the dock renders no strip at all.
    expect(screen.queryByTestId('session-changes')).toBeNull()

    // The agent writes the file: the list grows AND the Host records it.
    files = [CHANGE]
    recorded = [CHANGE.path]
    rerender(<SessionChangesDock {...props} />)
    expand()
    expect(await screen.findByRole('button', { name: zh['viewChanges'] })).toBeTruthy()
  })

  it('reports how many files a revert restored', async () => {
    const results: readonly RevertFileResult[] = [{ path: '/proj/a.txt', status: 'reverted' }]
    render(<SessionChangesDock {...dockProps({ revisions: verbs({ revertAll: async () => results }) }).props} />)
    expand()
    fireEvent.click(await screen.findByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertDone', { count: 1 }))).toBeTruthy()
    })
  })

  it('reports files whose changes had been overwritten', async () => {
    const results: readonly RevertFileResult[] = [
      { path: '/proj/a.txt', status: 'conflict' },
      { path: '/proj/b.txt', status: 'reverted' },
    ]
    render(<SessionChangesDock {...dockProps({ revisions: verbs({ revertAll: async () => results }) }).props} />)
    expand()
    fireEvent.click(await screen.findByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertConflict', { count: 1 }))).toBeTruthy()
    })
  })

  it('reports a revert that failed outright', async () => {
    render(<SessionChangesDock {...dockProps({
      revisions: verbs({ revertAll: async () => { throw new Error('host refused') } }),
    }).props} />)
    expand()
    fireEvent.click(await screen.findByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertFailed', { message: 'host refused' }))).toBeTruthy()
    })
  })

  it('refetches the recorded set after a revert so a retired path stops offering its controls', async () => {
    // Built by hand because the Host's set MOVES here: the dock must re-read it
    // after a revert rather than keep the array it started with.
    let recorded = [CHANGE.path]
    const seat = createAcceptedChangesStore().create('s1')
    const props = {
      useConversation: () => conversation,
      useProjection: () => ({ files: [CHANGE] }),
      useStore: bindSnapshotSelector(seat),
      actions: seat.actions,
      sessionId: 's1',
      cwd: '/proj',
      openFile: async () => {},
      revisions: verbs({
        list: async () => recorded.map(entry),
        revertAll: async () => {
          // A successful revert retires the path on the Host, so the next
          // listing no longer reports it.
          recorded = []
          return [{ path: CHANGE.path, status: 'reverted' as const }]
        },
      }),
      openViewer: () => {},
      t,
    } as unknown as Parameters<typeof SessionChangesDock>[0]
    render(<SessionChangesDock {...props} />)
    await expandWithRevision()
    fireEvent.click(await screen.findByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: zh['viewChanges'] })).toBeNull()
    })
  })
})

describe('the viewer request source', () => {
  it('starts closed and hands subscribers the newest request', async () => {
    const { createRevisionViewerSource } = await import('../src/client/revision-viewer-request.ts')
    const source = createRevisionViewerSource()
    const seen: (RevisionViewerRequest | undefined)[] = []
    source.requests.subscribe(() => { seen.push(source.requests.getSnapshot()) })

    expect(source.requests.getSnapshot()).toBeUndefined()
    source.publish({ sessionId: 's1', path: '/proj/a.txt', fileCount: 2 })
    source.publish(undefined)
    expect(seen).toEqual([
      { sessionId: 's1', path: '/proj/a.txt', fileCount: 2 },
      undefined,
    ])
  })

  it('returns an identical snapshot until a request lands', async () => {
    // The renderer's hook binding compares snapshots by identity, so a source
    // that rebuilt its value per read would re-render on every tick.
    const { createRevisionViewerSource } = await import('../src/client/revision-viewer-request.ts')
    const source = createRevisionViewerSource()
    source.publish({ sessionId: 's1', path: '/proj/a.txt', fileCount: 1 })
    expect(source.requests.getSnapshot()).toBe(source.requests.getSnapshot())
  })

  it('stops notifying a listener that unsubscribed', async () => {
    const { createRevisionViewerSource } = await import('../src/client/revision-viewer-request.ts')
    const source = createRevisionViewerSource()
    const listener = vi.fn()
    const stop = source.requests.subscribe(listener)
    source.publish({ sessionId: 's1', path: '/a', fileCount: 1 })
    stop()
    source.publish({ sessionId: 's1', path: '/b', fileCount: 1 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(source.requests.getSnapshot()).toMatchObject({ path: '/b' })
  })
})
