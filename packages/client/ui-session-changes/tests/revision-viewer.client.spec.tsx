// @vitest-environment jsdom

/**
 * The full-screen side-by-side viewer: what the reader sees when they open one
 * file's change, and the reading affordances git-style review surfaces are
 * expected to carry — both line numbers, both content columns, the +/- totals,
 * a navigation control over the changed regions, and a copy that emits a
 * standard diff.
 *
 * The alignment model itself is covered in revision-diff-model.spec.ts; these
 * specs are about the surface that draws it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { RevisionDiffOverlay } from '../src/client/RevisionDiffOverlay.tsx'
import { RevisionError } from '../src/client/revision-remote.ts'
import { zh } from '../src/client/locales.ts'
import type { RevisionDiff } from '@deepseek-ai/dsh-api-session-file-revisions/types'
import '@deepseek-ai/dsh-client-ui-session-changes/client'

const t: Parameters<typeof RevisionDiffOverlay>[0]['t'] = makeTranslate(zh, commonZh)

afterEach(() => { cleanup() })

/** A loaded diff, as the Host Remote returns it. */
function diffOf(baseline: string | null, endState: string, withheld: RevisionDiff['withheld'] = null): RevisionDiff {
  return { path: '/proj/a.ts', origin: withheld === 'baseline-missing' ? 'unknown' : 'existing', baseline, endState, withheld }
}

/**
 * Mount the viewer over one diff.
 * @param resolved - the diff the Remote resolves to, or a rejection.
 * @returns the render result plus the close spy.
 */
function mount(resolved: RevisionDiff | Error, path = '/proj/a.ts') {
  const onClose = vi.fn()
  const diff = vi.fn(() => resolved instanceof Error
    ? Promise.reject(resolved)
    : Promise.resolve(resolved))
  render(
    <RevisionDiffOverlay
      open
      sessionId="s1"
      path={path}
      fileCount={3}
      diff={diff}
      onClose={onClose}
      t={t}
    />,
  )
  return { onClose, diff }
}

/**
 * The viewer's dialog, once its diff has loaded.
 *
 * The modal portals into `document.body`, so the render result's own container
 * holds none of it — every structural query starts from this dialog.
 */
async function opened(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: zh['diff.title'] })
}

describe('the side-by-side viewer', () => {
  it('opens as a dialog titled by the diff, not as a strip panel', async () => {
    mount(diffOf('a\n', 'b\n'))
    expect(await opened()).toBeTruthy()
  })

  it('shows both versions as two labelled columns', async () => {
    mount(diffOf('before\n', 'after\n'))
    await opened()
    // The column captions are what make a split view readable: without them the
    // left/right sides are unlabelled and the reader has to infer which is which.
    expect(screen.getByText(zh['diff.baseline'])).toBeTruthy()
    expect(screen.getByText(zh['diff.current'])).toBeTruthy()
  })

  it('renders the removed line and the added line on the same row', async () => {
    mount(diffOf('old-line\n', 'new-line\n'))
    const dialog = await opened()
    const panes = dialog.querySelectorAll('[data-kind]')
    // Row 1 of each column: the pairing is what keeps the two sides comparable.
    expect([...panes].map(node => node.getAttribute('data-kind')))
      .toEqual(['removed', 'added'])
    // The line text is split by the interior mark (the changed characters), so
    // the assertion is on the row's whole text rather than one text node.
    const [removed, added] = [...panes]
    expect(removed?.textContent).toBe('1old-line')
    expect(added?.textContent).toBe('1new-line')
  })

  it('numbers both sides so a reader can cite a line', async () => {
    mount(diffOf('a\nb\n', 'a\nB\n'))
    await opened()
    // Each side carries the gutter for its own version: "line 2" is ambiguous
    // in a diff, so both numbers are shown.
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(2)
  })

  it('reports the added and removed line totals', async () => {
    mount(diffOf('a\nb\nc\n', 'a\nX\nY\n'))
    await opened()
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.getByText('-2')).toBeTruthy()
  })

  it('marks the changed characters inside a replaced line', async () => {
    mount(diffOf('const a = 1\n', 'const a = 2\n'))
    const dialog = await opened()
    // The interior mark is what tells a reader WHICH part of a similar line
    // moved, which a whole-line highlight cannot.
    expect(dialog.querySelectorAll('mark').length).toBeGreaterThanOrEqual(2)
  })

  it('offers change navigation with a position readout', async () => {
    mount(diffOf('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n'))
    await opened()
    expect(screen.getByText(zh['diff.changes'].replace('{count}', '2'))).toBeTruthy()
    const next = screen.getByRole('button', { name: zh['diff.next'] })
    fireEvent.click(next)
    await waitFor(() => {
      // Two separate replacements, so stepping lands on the first of two.
      expect(screen.getByText(zh['diff.position'].replace('{current}', '1').replace('{count}', '2'))).toBeTruthy()
    })
  })

  it('steps to the previous change and wraps around', async () => {
    mount(diffOf('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n'))
    await opened()
    const previous = screen.getByRole('button', { name: zh['diff.previous'] })
    fireEvent.click(previous)
    await waitFor(() => {
      // Stepping back from the start wraps to the LAST change.
      expect(screen.getByText(zh['diff.position'].replace('{current}', '2').replace('{count}', '2'))).toBeTruthy()
    })
  })

  it('copies a standard unified diff rather than the two-column layout', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    mount(diffOf('a\nb\n', 'a\nB\n'))
    await opened()
    fireEvent.click(screen.getByRole('button', { name: zh['diff.copy'] }))
    await waitFor(() => {
      // What lands in a terminal or a patch file has to be a unified diff.
      expect(writeText).toHaveBeenCalledWith(' a\n-b\n+B')
    })
  })

  it('says a file is too large instead of drawing a wrong diff', async () => {
    mount(diffOf(null, '', 'oversized'))
    await opened()
    expect(screen.getByText(zh['diff.oversized'])).toBeTruthy()
  })

  it('says an uncaptured baseline leaves nothing to compare', async () => {
    mount(diffOf(null, '', 'baseline-missing'))
    await opened()
    expect(screen.getByText(zh['diff.baselineMissing'])).toBeTruthy()
  })

  it('says a file with no changes has none', async () => {
    mount(diffOf('same\n', 'same\n'))
    await opened()
    expect(screen.getByText(zh['diff.empty'])).toBeTruthy()
  })

  it('reports a refused read under the viewer label and offers no diff', async () => {
    // An unmapped failure keeps the Host's own diagnostic, under the verb's own
    // label: the viewer is what was refused, and the reader needs to know that
    // before reading the reason.
    mount(new Error('the host broke'))
    await opened()
    expect(screen.getByRole('alert').textContent).toBe(t('diff.viewerFailed', { message: 'the host broke' }))
    expect(screen.queryByText(zh['diff.baseline'])).toBeNull()
  })

  it('says the session recorded nothing for the file', async () => {
    // The dock offers this viewer for paths the Host has no revision for, so
    // this is an expected answer rather than an anomaly; the reader gets a
    // sentence about their own situation instead of a raw Host diagnostic.
    mount(new RevisionError('session-revisions/unknown-path', 'no record for that path'))
    await opened()
    expect(screen.getByRole('alert').textContent).toBe(zh['diff.noRecord'])
  })

  it('says the session workspace could not be resolved', async () => {
    // The other mapped code names a different situation — the reader's own
    // session is the problem, not the file — so it earns its own sentence.
    mount(new RevisionError('session-revisions/no-workspace', 'session has no workspace root: s1'))
    await opened()
    expect(screen.getByRole('alert').textContent).toBe(zh['diff.noWorkspace'])
  })

  it('closes through the header control', async () => {
    const { onClose } = mount(diffOf('a\n', 'b\n'))
    await opened()
    fireEvent.click(screen.getByRole('button', { name: zh['diff.close'] }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the file name and its directory separately', async () => {
    mount(diffOf('a\n', 'b\n'))
    await opened()
    // The name is what the reader scans for; the full path stays available.
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('/proj/a.ts')).toBeTruthy()
  })
})

describe('keyboard navigation', () => {
  it('steps between changes with J and K', async () => {
    // The footer advertises J/K, so they have to work without the reader first
    // clicking something. A keydown handler on a non-focusable element only
    // fires when a DESCENDANT holds focus, which is not a state the reader can
    // be assumed to be in.
    mount(diffOf('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n'))
    await opened()
    fireEvent.keyDown(document.body, { key: 'j' })
    await waitFor(() => {
      expect(screen.getByText(zh['diff.position'].replace('{current}', '1').replace('{count}', '2'))).toBeTruthy()
    })
  })
})

describe('lane symmetry', () => {
  it('draws one cell per row in each lane, so the lanes stay comparable', async () => {
    // The two lanes are one comparison read row by row. A lane that skipped a
    // row would compare every later line against the wrong counterpart, so the
    // filler half of a one-sided change still consumes a row.
    mount(diffOf('a\nb\nc\n', 'a\nNEW1\nNEW2\nNEW3\nc\n'))
    const dialog = await opened()
    const lanes = [...dialog.querySelectorAll('[data-kind]')].map(node => node.getAttribute('data-kind'))
    // The DOM groups cells by lane: the left lane's rows, then the right's.
    expect(lanes.length % 2).toBe(0)
    const half = lanes.length / 2
    expect(lanes.slice(0, half)).toEqual(['context', 'removed', 'filler', 'filler', 'context'])
    expect(lanes.slice(half)).toEqual(['context', 'added', 'added', 'added', 'context'])
  })

  it('gives a deletion a filler on the added side', async () => {
    mount(diffOf('a\nGONE\nb\n', 'a\nb\n'))
    const dialog = await opened()
    const lanes = [...dialog.querySelectorAll('[data-kind]')].map(node => node.getAttribute('data-kind'))
    const half = lanes.length / 2
    expect(lanes.slice(0, half)).toEqual(['context', 'removed', 'context'])
    expect(lanes.slice(half)).toEqual(['context', 'filler', 'context'])
  })
})

describe('change focus', () => {
  it('marks the current change on BOTH columns', async () => {
    // The two columns are one comparison, so a marker that lands on only one
    // side highlights half the row the reader is being pointed at.
    mount(diffOf('a\nb\nc\n', 'a\nB\nc\n'))
    const dialog = await opened()
    fireEvent.keyDown(document.body, { key: 'j' })
    await waitFor(() => {
      expect(dialog.querySelectorAll('[data-focused="true"]').length).toBe(2)
    })
  })
})

describe('rows whose language has no grammar', () => {
  it('still renders the line text', async () => {
    // highlightLines returns undefined for an unknown extension and for a
    // grammar that has not loaded yet. The renderer must fall back to the plain
    // text: a fallback that renders nothing would blank out every line of the
    // file, which reads as an empty diff rather than an unhighlighted one.
    mount({
      path: '/proj/notes.unknownext',
      origin: 'existing',
      baseline: 'alpha\n',
      endState: 'beta\n',
      withheld: null,
    })
    const dialog = await opened()
    await waitFor(() => {
      expect(dialog.querySelectorAll('[data-kind]').length).toBe(2)
    })
    const [removed, added] = [...dialog.querySelectorAll('[data-kind]')]
    expect(removed?.textContent).toBe('1alpha')
    expect(added?.textContent).toBe('1beta')
  })
})
