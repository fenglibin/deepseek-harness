/**
 * Behavior specs for the added/removed line counts the changed-file list shows.
 *
 * The case that matters is the one the old whole-file count got wrong: a file
 * whose single line changed. A spec that only replaces a file's entire content
 * cannot tell a real line diff from a total line count, because the two agree
 * there — which is exactly how the defect hid.
 */

import { describe, expect, it } from 'vitest'
import { lineCounts } from '../src/line-counts.ts'

/** One revision, as the counters read it. */
function revision(origin: 'existing' | 'absent' | 'unknown' | 'deleted', baseline: string | null, endState: string) {
  return { origin, baseline, endState }
}

describe('lineCounts', () => {
  it('counts a single changed line as one addition and one removal', () => {
    // Both files are three lines long; the change is ONE line. A total line
    // count would report 3 and 3 here.
    expect(lineCounts(revision('existing', 'a\nb\nc\n', 'a\nB\nc\n'))).toEqual({ added: 1, removed: 1 })
  })

  it('does not count unchanged lines around the change', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${String(index)}\n`).join('')
    const changed = lines.replace('line 50\n', 'changed\n')
    expect(lineCounts(revision('existing', lines, changed))).toEqual({ added: 1, removed: 1 })
  })

  it('counts an appended line as pure addition', () => {
    expect(lineCounts(revision('existing', 'a\nb\n', 'a\nb\nc\n'))).toEqual({ added: 1, removed: 0 })
  })

  it('counts a removed line as pure removal', () => {
    expect(lineCounts(revision('existing', 'a\nb\nc\n', 'a\nc\n'))).toEqual({ added: 0, removed: 1 })
  })

  it('counts a whole-file replacement on both sides', () => {
    // The old implementation happened to agree here, which is why the defect
    // survived its own test.
    expect(lineCounts(revision('existing', 'old\n', 'new\nlonger\n'))).toEqual({ added: 2, removed: 1 })
  })

  it('counts a created file as pure additions', () => {
    expect(lineCounts(revision('absent', null, 'a\nb\n'))).toEqual({ added: 2, removed: 0 })
  })

  it('reports nothing for an uncaptured baseline', () => {
    // Neither side is derivable, so claiming the end state's lines as added
    // would assert a whole-file addition the capture cannot support.
    expect(lineCounts(revision('unknown', null, 'a\nb\nc\n'))).toEqual({ added: 0, removed: 0 })
  })

  it('reports nothing for a deleted path', () => {
    // A deleted path carries no content of its own, and the row reports the
    // deletion itself rather than a line count.
    expect(lineCounts(revision('deleted', null, ''))).toEqual({ added: 0, removed: 0 })
  })

  it('reports nothing when both sides are empty', () => {
    expect(lineCounts(revision('existing', '', ''))).toEqual({ added: 0, removed: 0 })
  })

  it('counts an empty replacement file as pure removal', () => {
    expect(lineCounts(revision('existing', 'a\nb\n', ''))).toEqual({ added: 0, removed: 2 })
  })

  it('counts a file whose trailing newline was added as one change, not two', () => {
    // `a\nb` and `a\nb\n` hold the same two lines; only the terminator differs,
    // so this is one removal and one addition rather than a line-count shift.
    expect(lineCounts(revision('existing', 'a\nb', 'a\nb\n'))).toEqual({ added: 1, removed: 1 })
  })
})
