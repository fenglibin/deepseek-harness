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
  return {
    path,
    operation: 'write',
    origin: 'existing',
    added: 1,
    removed: 0,
    oversized: false,
    firstSeq: 10,
    lastSeq: 10,
  }
}

/**
 * Dock props for one mount, capturing what the dock asked the viewer to show.
 *
 * The recorded set is stated once through `recorded` and overrides whatever
 * `revisions.list` says, so a spec never repeats the Host's path set inside a
 * verb. A spec that needs the set to change while mounted (a revert retiring a
 * path) builds its own props instead, since a captured array cannot move.
 *
 * `recordedEntries` states the set as full entries, for the specs that assert
 * what one record SAYS (line counts, origin) rather than only that it exists.
 */
function dockProps(options: {
  revisions?: RevisionRemote | undefined
  recorded?: readonly string[]
  recordedEntries?: readonly RevisionEntry[]
  files?: readonly SessionChange[]
} = {}) {
  const recorded = options.recorded ?? [CHANGE.path]
  const opened: RevisionViewerRequest[] = []
  const seat = createAcceptedChangesStore().create('s1')
  const revisions = options.revisions === undefined
    ? undefined
    : {
      ...options.revisions,
      list: async () => options.recordedEntries ?? recorded.map(entry),
    }
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
    revert: async () => [],
    ...overrides,
  }
}

/** Open the collapsed strip so its rows are reachable. */
function expand(): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['title']) }))
}

/**
 * Walk the bulk revert's confirmation, which is what actually issues the call.
 *
 * Reverting writes to disk irreversibly, so the strip's control only opens a
 * dialog; every spec that means to revert has to acknowledge it first.
 * @param action - bulk or one row's control, already found.
 * @returns once the confirmed request has been issued.
 */
async function confirmBulkRevert(action: HTMLElement): Promise<void> {
  fireEvent.click(action)
  const acknowledge = await screen.findByRole('checkbox')
  fireEvent.click(acknowledge)
  fireEvent.click(screen.getByRole('button', { name: zh['revertConfirmAction'] }))
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

  it('still offers view-changes for a listed path the Host recorded no revision for', async () => {
    // The changed-file list is folded from the durable log while the revision
    // record lives on the Host's own side, so the two disagree for paths the
    // list knows and the record does not. The viewer is opened for those too: it
    // is read-only, and its own sentence says the session recorded nothing —
    // whereas hiding the control made the whole feature look absent.
    const props = dockProps({ revisions: verbs(), recorded: [] })
    render(<SessionChangesDock {...props.props} />)
    expand()
    await waitFor(() => {
      expect(screen.getByText(zh['view.pending'])).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: zh['viewChanges'] }))
    expect(props.opened).toEqual([{ sessionId: 's1', path: '/proj/a.txt', fileCount: 1 }])
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
    render(<SessionChangesDock {...dockProps({ revisions: verbs({ revert: async () => results }) }).props} />)
    expand()
    await confirmBulkRevert(await screen.findByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertDone', { count: 1 }))).toBeTruthy()
    })
  })

  it('reports files whose changes had been overwritten', async () => {
    const results: readonly RevertFileResult[] = [
      { path: '/proj/a.txt', status: 'conflict' },
      { path: '/proj/b.txt', status: 'reverted' },
    ]
    render(<SessionChangesDock {...dockProps({ revisions: verbs({ revert: async () => results }) }).props} />)
    expand()
    await confirmBulkRevert(await screen.findByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertConflict', { count: 1 }))).toBeTruthy()
    })
  })

  it('reports a revert that failed outright', async () => {
    render(<SessionChangesDock {...dockProps({
      revisions: verbs({ revert: async () => { throw new Error('host refused') } }),
    }).props} />)
    expand()
    await confirmBulkRevert(await screen.findByRole('button', { name: zh['revertAll'] }))
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
        revert: async () => {
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
    await confirmBulkRevert(screen.getByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      // The retired path stops offering revert, which is what the refetch is
      // for. View-changes stays: it is read-only, and a path with no record
      // opens the viewer's own "nothing recorded" sentence.
      expect(screen.queryByRole('button', { name: zh['revertOne'] })).toBeNull()
    })
  })
})

describe('the changed rows', () => {
  /** One recorded entry with explicit counts and origin, for row assertions. */
  function recordedEntry(overrides: Partial<RevisionEntry> = {}): RevisionEntry {
    return { ...entry('/proj/a.txt'), ...overrides }
  }

  /** Mount the dock with one recorded entry and expand it. */
  async function mountWith(recorded: readonly RevisionEntry[], files: readonly SessionChange[] = [CHANGE]) {
    const props = dockProps({ revisions: verbs(), recordedEntries: recorded, files })
    render(<SessionChangesDock {...props.props} />)
    // The strip renders nothing until it has a row, and a record-derived row
    // arrives one microtask after mount — so the wait precedes the expand.
    await waitFor(() => { expect(screen.getByTestId('session-changes')).toBeTruthy() })
    expand()
    await waitFor(() => { expect(screen.getByText(zh['view.pending'])).toBeTruthy() })
    return props
  }

  it('shows the added and removed line counts the Host reported', async () => {
    await mountWith([recordedEntry({ added: 38, removed: 108 })])
    expect(screen.getByText('+38')).toBeTruthy()
    expect(screen.getByText('-108')).toBeTruthy()
  })

  it('shows a deletion instead of line counts for a path the session deleted', async () => {
    // A deleted path has no content of its own, so two zeroes would say less
    // than the word does — and the row is the only place the reader learns the
    // session removed the file at all.
    await mountWith([recordedEntry({ origin: 'deleted', added: 0, removed: 0, operation: 'delete' })])
    expect(screen.getByText(zh['deleted'])).toBeTruthy()
    expect(screen.queryByText('+0')).toBeNull()
  })

  it('lists a deleted path the change log never named', async () => {
    // The changed-files fold reads write calls, so a file a shell command
    // deleted appears nowhere in it. Without the record's contribution the
    // reader could not see the deletion, let alone restore it.
    await mountWith(
      [{ ...entry('/proj/gone.txt'), origin: 'deleted', operation: 'delete', firstSeq: 7, lastSeq: 7 }],
      [],
    )
    expect(screen.getByText('gone.txt')).toBeTruthy()
  })

  it('adds no second row for a path the change log already lists', async () => {
    // The record adds detail to a row, not a duplicate: a path in both sources
    // occupies one row.
    await mountWith([recordedEntry({ origin: 'deleted', operation: 'delete' })])
    expect(screen.getAllByText('a.txt')).toHaveLength(1)
  })

  it('renders the row actions as labelled icon buttons', async () => {
    await mountWith([recordedEntry()])
    // Each action keeps an accessible name while showing only a glyph, so the
    // row reads as icons to the eye and as buttons to assistive technology.
    expect(screen.getByRole('button', { name: zh['viewChanges'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['accept'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['revertOne'] })).toBeTruthy()
  })

  it('offers no per-file revert where the Host recorded no revision', async () => {
    await mountWith([])
    expect(screen.queryByRole('button', { name: zh['revertOne'] })).toBeNull()
  })

  it('reverts one path through the same verb, naming only that path', async () => {
    const seen: (string | undefined)[] = []
    const props = dockProps({
      revisions: verbs({
        list: async () => [entry(CHANGE.path)],
        revert: async (_sessionId, path) => {
          seen.push(path)
          return [{ path: CHANGE.path, status: 'reverted' }]
        },
      }),
    })
    render(<SessionChangesDock {...props.props} />)
    await expandWithRevision()
    fireEvent.click(screen.getByRole('button', { name: zh['revertOne'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertOneDone', { name: 'a.txt' }))).toBeTruthy()
    })
    expect(seen).toEqual([CHANGE.path])
  })

  it('says why a deleted path could not be restored', async () => {
    const props = dockProps({
      revisions: verbs({
        list: async () => [entry(CHANGE.path)],
        revert: async () => [{ path: CHANGE.path, status: 'missing', blocked: 'not-in-git' }],
      }),
    })
    render(<SessionChangesDock {...props.props} />)
    await expandWithRevision()
    fireEvent.click(screen.getByRole('button', { name: zh['revertOne'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertNotInGit', { name: 'a.txt' }))).toBeTruthy()
    })
  })

  it('names the workspace rather than the file when git itself is absent', async () => {
    // The two blocked causes are different situations: a path git never tracked
    // is a fact about that file, while a workspace outside version control is a
    // fact about the whole session — and the sentence has to say which.
    const props = dockProps({
      revisions: verbs({
        list: async () => [entry(CHANGE.path)],
        revert: async () => [{ path: CHANGE.path, status: 'missing', blocked: 'not-a-repository' }],
      }),
    })
    render(<SessionChangesDock {...props.props} />)
    await expandWithRevision()
    fireEvent.click(screen.getByRole('button', { name: zh['revertOne'] }))
    await waitFor(() => {
      expect(screen.getByText(zh['revertNoRepository'])).toBeTruthy()
    })
  })

  it('does not reissue a path whose revert is already running', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const props = dockProps({
      revisions: verbs({
        list: async () => [entry(CHANGE.path)],
        revert: async () => {
          calls += 1
          await gate
          return [{ path: CHANGE.path, status: 'reverted' }]
        },
      }),
    })
    render(<SessionChangesDock {...props.props} />)
    await expandWithRevision()
    const button = screen.getByRole('button', { name: zh['revertOne'] })
    fireEvent.click(button)
    await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(true) })
    // A second click while the first is in flight must not start a second
    // revert of the same file.
    fireEvent.click(button)
    expect(calls).toBe(1)
    release?.()
  })

  it('reports a single revert whose changes had been overwritten', async () => {
    // A path-scoped revert answers for one file, so a conflict there is reported
    // through the batch wording rather than the per-path blocked reasons.
    const props = dockProps({
      revisions: verbs({
        list: async () => [entry(CHANGE.path)],
        revert: async () => [{ path: CHANGE.path, status: 'conflict' }],
      }),
    })
    render(<SessionChangesDock {...props.props} />)
    await expandWithRevision()
    fireEvent.click(screen.getByRole('button', { name: zh['revertOne'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertConflict', { count: 1 }))).toBeTruthy()
    })
  })

  it('reports a failing single revert through the verb its own failure label', async () => {
    const props = dockProps({
      revisions: verbs({
        list: async () => [entry(CHANGE.path)],
        revert: async () => { throw new Error('host refused') },
      }),
    })
    render(<SessionChangesDock {...props.props} />)
    await expandWithRevision()
    fireEvent.click(screen.getByRole('button', { name: zh['revertOne'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertFailed', { message: 'host refused' }))).toBeTruthy()
    })
  })

  it('orders a record-supplied row among the folded ones by its first seq', async () => {
    // The record contributes paths the log cannot place, so its seq — not its
    // arrival in the map — decides where the row lands.
    const folded: SessionChange[] = [
      { path: '/proj/from-log.txt', operation: 'write', firstSeq: 20, lastSeq: 20 },
    ]
    await mountWith(
      [{ ...entry('/proj/gone.txt'), origin: 'deleted', operation: 'delete', firstSeq: 5, lastSeq: 5 }],
      folded,
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('gone.txt')
    expect(rows[1]?.textContent).toContain('from-log.txt')
  })

  it('leaves the confirmed dialog once the reader confirms', async () => {
    const props = dockProps({
      revisions: verbs({ list: async () => [entry(CHANGE.path)], revert: async () => [] }),
    })
    render(<SessionChangesDock {...props.props} />)
    await expandWithRevision()
    fireEvent.click(screen.getByRole('button', { name: zh['revertAll'] }))
    const acknowledge = await screen.findByRole('checkbox')
    fireEvent.click(acknowledge)
    fireEvent.click(screen.getByRole('button', { name: zh['revertConfirmAction'] }))
    // Confirming closes the dialog rather than leaving it open behind the result.
    await waitFor(() => { expect(screen.queryByRole('checkbox')).toBeNull() })
  })

  it('cancels without reverting anything', async () => {
    // Cancelling must not reach the Host: the dialog is the only thing standing
    // between a stray click and an irreversible write. The modal renders its own
    // close control under the same label, so the footer's cancel is picked by
    // its accessible name among the two.
    let calls = 0
    const props = dockProps({
      revisions: verbs({
        list: async () => [entry(CHANGE.path)],
        revert: async () => { calls += 1; return [] },
      }),
    })
    render(<SessionChangesDock {...props.props} />)
    await expandWithRevision()
    fireEvent.click(screen.getByRole('button', { name: zh['revertAll'] }))
    const cancels = await screen.findAllByRole('button', { name: zh['revertConfirmCancel'] })
    fireEvent.click(cancels[cancels.length - 1] as HTMLElement)
    await waitFor(() => { expect(screen.queryByRole('checkbox')).toBeNull() })
    expect(calls).toBe(0)
  })

  it('requires the acknowledgement before the confirm action is usable', async () => {
    const props = dockProps({
      revisions: verbs({ list: async () => [entry(CHANGE.path)], revert: async () => [] }),
    })
    render(<SessionChangesDock {...props.props} />)
    await expandWithRevision()
    fireEvent.click(screen.getByRole('button', { name: zh['revertAll'] }))
    const confirm = await screen.findByRole('button', { name: zh['revertConfirmAction'] })
    expect(confirm.hasAttribute('disabled')).toBe(true)
  })

  it('keeps the view-changes control when the recorded listing itself fails', async () => {
    // A failed listing means the dock cannot know which paths are revertible, so
    // it offers no revert rather than a control that would fail on click. The
    // changed-file list and the viewer are independent of that listing: the
    // viewer answers for a path with no record by saying so, so it stays.
    //
    // Built by hand because the listing is the thing under test, and `dockProps`
    // supplies its own non-failing one.
    const seat = createAcceptedChangesStore().create('s1')
    const props = {
      useConversation: () => conversation,
      useProjection: () => ({ files: [CHANGE] }),
      useStore: bindSnapshotSelector(seat),
      actions: seat.actions,
      sessionId: 's1',
      cwd: '/proj',
      openFile: async () => {},
      revisions: verbs({ list: async () => { throw new Error('listing failed') } }),
      openViewer: () => {},
      t,
    } as unknown as Parameters<typeof SessionChangesDock>[0]
    render(<SessionChangesDock {...props} />)
    expand()
    await waitFor(() => { expect(screen.getByText(zh['view.pending'])).toBeTruthy() })
    expect(screen.getByRole('button', { name: zh['viewChanges'] })).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['revertOne'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['revertAll'] })).toBeNull()
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
