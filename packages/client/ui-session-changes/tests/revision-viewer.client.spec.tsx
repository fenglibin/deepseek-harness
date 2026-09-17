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
function mount(resolved: RevisionDiff | Error) {
  const onClose = vi.fn()
  const diff = vi.fn(() => resolved instanceof Error
    ? Promise.reject(resolved)
    : Promise.resolve(resolved))
  render(
    <RevisionDiffOverlay
      open
      sessionId="s1"
      path="/proj/a.ts"
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

  it('reports a refused read and offers no diff', async () => {
    mount(new Error('the host broke'))
    await opened()
    expect(screen.getByRole('alert').textContent).toBe('the host broke')
    expect(screen.queryByText(zh['diff.baseline'])).toBeNull()
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
