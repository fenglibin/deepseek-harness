// @vitest-environment jsdom

/**
 * The dock's view-diff and revert surface: the controls appear only when the
 * composition captures revisions, the panel loads and renders one file's
 * cumulative diff, oversized files say so instead of showing content, and a
 * revert reports its per-path outcome.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionChangesDock, type SessionChange } from '../src/client/SessionChangesDock.tsx'
import { createAcceptedChangesStore } from '../src/client/accept-store.ts'
import { zh } from '../src/client/locales.ts'
import type { RevisionRemote } from '../src/client/RevisionDiffPanel.tsx'
import type {
  RevisionDiff, RevertFileResult,
} from '@deepseek-ai/dsh-api-session-file-revisions/types'
import '@deepseek-ai/dsh-client-ui-session-changes/client'

const t: Parameters<typeof SessionChangesDock>[0]['t'] = makeTranslate(zh, commonZh)

/** A blank conversation, so the dock exercises the projection path. */
const conversation = { views: { get: () => undefined } } as unknown as ConversationSnapshot

const CHANGE: SessionChange = {
  path: '/proj/a.txt', operation: 'write', firstSeq: 10, lastSeq: 10,
}

afterEach(() => { cleanup() })

/** One dock mount with the given revision verbs. */
function mount(revisions: RevisionRemote | undefined) {
  const seat = createAcceptedChangesStore().create('s1')
  const props: Parameters<typeof SessionChangesDock>[0] = {
    useConversation: () => conversation,
    useProjection: () => ({ files: [CHANGE] }),
    useStore: bindSnapshotSelector(seat),
    actions: seat.actions,
    sessionId: 's1',
    cwd: '/proj',
    openFile: async () => {},
    revisions,
    t,
  } as unknown as Parameters<typeof SessionChangesDock>[0]
  return { ...render(<SessionChangesDock {...props} />), seat }
}

describe('dock revision controls', () => {
  it('offers no view-diff or revert when revisions are absent', () => {
    mount(undefined)
    expect(screen.queryByRole('button', { name: zh['viewChanges'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['revertAll'] })).toBeNull()
  })

  it('offers both controls when revisions are present', () => {
    mount({ diff: async () => ({ path: '', baseline: null, endState: '', oversized: false }), revertAll: async () => [] })
    // The strip starts collapsed; open it to reach the rows.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['title']) }))
    expect(screen.getByRole('button', { name: zh['viewChanges'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['revertAll'] })).toBeTruthy()
  })

  it('loads and renders one file cumulative diff', async () => {
    const diff: RevisionDiff = {
      path: '/proj/a.txt', baseline: 'old\n', endState: 'new\n', oversized: false,
    }
    mount({ diff: async () => diff, revertAll: async () => [] })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['title']) }))
    fireEvent.click(screen.getByRole('button', { name: zh['viewChanges'] }))
    await waitFor(() => {
      expect(screen.getByTestId('revision-diff')).toBeTruthy()
    })
    expect(screen.getByText('old')).toBeTruthy()
    expect(screen.getByText('new')).toBeTruthy()
  })

  it('says a file is too large instead of showing content', async () => {
    mount({
      diff: async () => ({ path: '/proj/a.txt', baseline: null, endState: '', oversized: true }),
      revertAll: async () => [],
    })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['title']) }))
    fireEvent.click(screen.getByRole('button', { name: zh['viewChanges'] }))
    await waitFor(() => {
      expect(screen.getByText(zh['diff.oversized'])).toBeTruthy()
    })
  })

  it('reports how many files a revert restored', async () => {
    const results: readonly RevertFileResult[] = [{ path: '/proj/a.txt', status: 'reverted' }]
    mount({ diff: async () => ({ path: '', baseline: null, endState: '', oversized: false }), revertAll: async () => results })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['title']) }))
    fireEvent.click(screen.getByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertDone', { count: 1 }))).toBeTruthy()
    })
  })

  it('reports files whose changes had been overwritten', async () => {
    const results: readonly RevertFileResult[] = [
      { path: '/proj/a.txt', status: 'conflict' },
      { path: '/proj/b.txt', status: 'reverted' },
    ]
    mount({ diff: async () => ({ path: '', baseline: null, endState: '', oversized: false }), revertAll: async () => results })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['title']) }))
    fireEvent.click(screen.getByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertConflict', { count: 1 }))).toBeTruthy()
    })
  })

  it('reports a revert that failed outright', async () => {
    mount({
      diff: async () => ({ path: '', baseline: null, endState: '', oversized: false }),
      revertAll: async () => { throw new Error('host refused') },
    })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['title']) }))
    fireEvent.click(screen.getByRole('button', { name: zh['revertAll'] }))
    await waitFor(() => {
      expect(screen.getByText(t('revertFailed', { message: 'host refused' }))).toBeTruthy()
    })
  })
})
