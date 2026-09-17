// @vitest-environment jsdom

/**
 * The side-by-side projection: how two versions of one file become aligned
 * rows. This is the split view's only real logic — the rendering above it just
 * draws what these rows say — so the boundaries are pinned here: replacement
 * pairs onto one row, a one-sided run fills the other column, and the line
 * numbers on each side stay honest.
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_SIDE_BY_SIDE, MAX_INLINE_DIFF_CHARS, sideBySide, unifiedDiffText,
} from '../src/client/revision-diff-model.ts'
import type { DiffRow } from '../src/client/revision-diff-model.ts'

/** One row as `[leftNumber, leftText, rightNumber, rightText]`, for readable assertions. */
function shape(rows: readonly DiffRow[]): unknown[] {
  return rows.map(row => [
    row.left.number, row.left.text, row.left.kind,
    row.right.number, row.right.text, row.right.kind,
  ])
}

describe('sideBySide alignment', () => {
  it('reports nothing for identical content', () => {
    expect(sideBySide('same\n', 'same\n')).toEqual(EMPTY_SIDE_BY_SIDE)
  })

  it('pairs a replacement onto ONE row so both columns stay aligned', () => {
    // The behavior that makes this a split view rather than a re-laid unified
    // diff: the removed line and the added line share a row.
    const { rows, added, removed } = sideBySide('a\nb\nc\n', 'a\nB\nc\n')
    expect(shape(rows)).toEqual([
      [1, 'a', 'context', 1, 'a', 'context'],
      [2, 'b', 'removed', 2, 'B', 'added'],
      [3, 'c', 'context', 3, 'c', 'context'],
    ])
    expect({ added, removed }).toEqual({ added: 1, removed: 1 })
  })

  it('fills the other column when a line was only added', () => {
    const { rows, added, removed } = sideBySide('a\nb\n', 'a\nNEW\nb\n')
    expect(shape(rows)).toEqual([
      [1, 'a', 'context', 1, 'a', 'context'],
      [null, null, 'filler', 2, 'NEW', 'added'],
      [2, 'b', 'context', 3, 'b', 'context'],
    ])
    expect({ added, removed }).toEqual({ added: 1, removed: 0 })
  })

  it('fills the other column when a line was only removed', () => {
    const { rows, added, removed } = sideBySide('a\nGONE\nb\n', 'a\nb\n')
    expect(shape(rows)).toEqual([
      [1, 'a', 'context', 1, 'a', 'context'],
      [2, 'GONE', 'removed', null, null, 'filler'],
      [3, 'b', 'context', 2, 'b', 'context'],
    ])
    expect({ added, removed }).toEqual({ added: 0, removed: 1 })
  })

  it('pairs an unequal run by index and fills the surplus', () => {
    // Two removals against one addition: the first pairs, the second is a
    // deletion with no counterpart. Both columns still advance together.
    const { rows } = sideBySide('x1\nx2\nkeep\n', 'y1\nkeep\n')
    expect(shape(rows)).toEqual([
      [1, 'x1', 'removed', 1, 'y1', 'added'],
      [2, 'x2', 'removed', null, null, 'filler'],
      [3, 'keep', 'context', 2, 'keep', 'context'],
    ])
  })

  it('treats a created file as an empty left column', () => {
    // `before: null` is a file this session created: a repository shows its
    // left column empty rather than inventing content to remove.
    const { rows, added, removed } = sideBySide(null, 'one\ntwo\n')
    expect(shape(rows)).toEqual([
      [null, null, 'filler', 1, 'one', 'added'],
      [null, null, 'filler', 2, 'two', 'added'],
    ])
    expect({ added, removed }).toEqual({ added: 2, removed: 0 })
  })

  it('numbers each side from its own first line across hunks', () => {
    // A distant change splits the file into two hunks; the numbers must keep
    // counting the real file, not restart at each hunk.
    const before = `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n')}\n`
    const after = before.replace('line2\n', 'CHANGED2\n').replace('line19\n', 'CHANGED19\n')
    const { rows, hunkStarts } = sideBySide(before, after)
    expect(hunkStarts.length).toBe(2)
    const changed = rows.filter(row => row.left.kind === 'removed')
    expect(changed.map(row => row.left.number)).toEqual([2, 19])
    expect(changed.map(row => row.right.number)).toEqual([2, 19])
  })

  it('counts a replaced line as one addition and one removal', () => {
    expect(sideBySide('a\nb\nc\n', 'a\nB\nC\n')).toMatchObject({ added: 2, removed: 2 })
  })

  it('keeps an interior blank line and ignores the trailing terminator', () => {
    const { rows } = sideBySide('a\n\nb\n', 'a\n\nB\n')
    // The blank line is a real line, so it occupies its own row.
    expect(rows).toHaveLength(3)
    expect(rows[1]!.left.text).toBe('')
    expect(rows[1]!.left.kind).toBe('context')
  })

  it('treats content without a trailing newline as the same line count', () => {
    const withNewline = sideBySide('a\nb\n', 'a\nB\n')
    const without = sideBySide('a\nb', 'a\nB')
    expect(shape(without.rows)).toEqual(shape(withNewline.rows))
  })

  it('handles a file whose whole content was deleted', () => {
    const { rows, added, removed } = sideBySide('a\nb\n', '')
    expect(added).toBe(0)
    expect(removed).toBe(2)
    expect(rows.every(row => row.right.kind === 'filler')).toBe(true)
  })

  it('handles a single-line file', () => {
    expect(shape(sideBySide('only\n', 'changed\n').rows)).toEqual([
      [1, 'only', 'removed', 1, 'changed', 'added'],
    ])
  })
})

describe('change runs', () => {
  it('marks the first row of each contiguous run and lists them in order', () => {
    const { rows, changeRuns } = sideBySide('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n')
    // Two separate replacements, so two runs and two navigation targets.
    expect(changeRuns).toEqual([1, 3])
    expect(rows.filter(row => row.changeRun).map(row => row.left.number)).toEqual([2, 4])
  })

  it('treats one uninterrupted replacement run as a single target', () => {
    const { changeRuns } = sideBySide('a\nb\nc\nd\n', 'a\nX\nY\nZ\n')
    expect(changeRuns).toEqual([1])
  })
})

describe('inline character spans', () => {
  it('marks the changed interior of a replaced line on both sides', () => {
    const [row] = sideBySide('const a = 1\n', 'const a = 2\n').rows
    // Only the differing character is marked, not the whole line.
    expect(row!.left.spans).toEqual([{ start: 10, end: 11 }])
    expect(row!.right.spans).toEqual([{ start: 10, end: 11 }])
  })

  it('marks only the added side when characters were inserted', () => {
    const [row] = sideBySide('abc\n', 'abXYZc\n').rows
    expect(row!.right.spans).toEqual([{ start: 2, end: 5 }])
    expect(row!.left.spans).toEqual([])
  })

  it('leaves context rows and one-sided rows unmarked', () => {
    const rows = sideBySide('a\nb\n', 'a\nNEW\nb\n').rows
    expect(rows.every(row => row.left.spans.length === 0 && row.right.spans.length === 0)).toBe(true)
  })

  it('skips the interior diff for a line past the length bound', () => {
    // A minified or generated line would make the character diff quadratic, so
    // the row keeps its whole-line highlight and gives up the interior marks.
    const wide = 'x'.repeat(MAX_INLINE_DIFF_CHARS + 1)
    const [row] = sideBySide(`${wide}\n`, `${wide}y\n`).rows
    expect(row!.left.spans).toEqual([])
    expect(row!.right.spans).toEqual([])
  })

  it('merges adjacent changed characters into one span', () => {
    const [row] = sideBySide('abcdef\n', 'abXYef\n').rows
    expect(row!.left.spans).toEqual([{ start: 2, end: 4 }])
  })
})

describe('unifiedDiffText', () => {
  it('emits a standard diff a terminal or patch tool accepts', () => {
    // What lands in a terminal or an issue has to be a unified diff, not the
    // two-column arrangement the screen draws.
    const projected = sideBySide('a\nb\nc\n', 'a\nB\nc\n')
    expect(unifiedDiffText(projected)).toBe(' a\n-b\n+B\n c')
  })

  it('emits one-sided lines for a pure insertion and a pure deletion', () => {
    expect(unifiedDiffText(sideBySide('a\nb\n', 'a\nNEW\nb\n'))).toBe(' a\n+NEW\n b')
    expect(unifiedDiffText(sideBySide('a\nGONE\nb\n', 'a\nb\n'))).toBe(' a\n-GONE\n b')
  })
})
