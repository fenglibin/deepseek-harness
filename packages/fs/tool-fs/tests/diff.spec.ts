/**
 * Unit tests for the result-time diff computation (`src/diff.ts`):
 * the pure before/after → {@link FileDiff}[] hunk builder and the defensive
 * `meta` narrowing. These pin the exact hunk reconstruction (only the truly
 * applied +/- lines per hunk — context lines around each change are excluded
 * so the line-count totals reflect the real change), multi-hunk replaceAll,
 * pure insertion/deletion, and no-op semantics that UIs render.
 */

import { describe, expect, it } from 'vitest'
import { computeHunkDiffs, CONTEXT_FOR_GROUPING, diffsFromMeta } from '../src/diff.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n') + '\n'

describe('computeHunkDiffs', () => {
  it('a single-line change yields one hunk containing only the changed line on each side (no context)', () => {
    const before = lines(8)
    const after = before.replace('line4', 'CHANGED')
    const diffs = computeHunkDiffs('f.txt', before, after)
    expect(diffs).toEqual([{
      path: 'f.txt',
      oldText: 'line4',
      newText: 'CHANGED',
    }])
  })

  it('a scattered replace_all yields one FileDiff PER hunk (matching per-site editor blocks)', () => {
    const before = lines(20)
    const after = before.replace('line3', 'A').replace('line16', 'B')
    const diffs = computeHunkDiffs('f.txt', before, after)
    expect(diffs).toHaveLength(2)
    expect(diffs[0]?.path).toBe('f.txt')
    expect(diffs[0]?.oldText).toBe('line3')
    expect(diffs[0]?.newText).toBe('A')
    expect(diffs[1]?.oldText).toBe('line16')
    expect(diffs[1]?.newText).toBe('B')
    // The two hunks are distinct sites, not one merged block.
    expect(diffs[0]?.newText).not.toContain('B')
    expect(diffs[1]?.newText).not.toContain('A')
  })

  it('identical before/after (a no-op) yields no hunks', () => {
    expect(computeHunkDiffs('f.txt', 'same\n', 'same\n')).toEqual([])
  })

  it('a pure insertion into empty content reports oldText null (nothing to diff against)', () => {
    const diffs = computeHunkDiffs('f.txt', '', 'brand new\n')
    expect(diffs).toEqual([{ path: 'f.txt', oldText: null, newText: 'brand new' }])
  })

  it('a pure deletion of the whole file reports newText empty', () => {
    const diffs = computeHunkDiffs('f.txt', 'gone\n', '')
    expect(diffs).toEqual([{ path: 'f.txt', oldText: 'gone', newText: '' }])
  })

  it('drops the "\\ No newline at end of file" marker from a no-trailing-newline change', () => {
    const diffs = computeHunkDiffs('f.txt', 'x', 'y')
    // The marker line (starting with "\\") must never leak into a diff block.
    expect(diffs).toEqual([{ path: 'f.txt', oldText: 'x', newText: 'y' }])
    expect(diffs[0]?.oldText).not.toContain('\\')
    expect(diffs[0]?.newText).not.toContain('\\')
  })

  it('a multi-line replacement produces exactly the removed and added blocks (no surrounding context)', () => {
    // The hunk's `oldText` carries ONLY the 2 removed lines; the `newText`
    // carries ONLY the 2 added lines. The 3 surrounding unchanged lines on
    // each side drive hunk grouping but never enter the produced file diff.
    const before = lines(20)
    const after = before.replace('line9\nline10', 'NEW1\nNEW2')
    const [diff] = computeHunkDiffs('f.txt', before, after)
    expect(diff?.oldText).toBe('line9\nline10')
    expect(diff?.newText).toBe('NEW1\nNEW2')
  })

  it('keeps the CONTEXT_FOR_GROUPING tunable at 3 so a scattered replaceAll still splits per site', () => {
    expect(CONTEXT_FOR_GROUPING).toBe(3)
  })

  it('a scattered replace_all separated by more than 2*CONTEXT_FOR_GROUPING unchanged lines splits into two hunks', () => {
    const before = lines(40)
    const after = before.replace('line4', 'A').replace('line36', 'B')
    const diffs = computeHunkDiffs('f.txt', before, after)
    expect(diffs).toHaveLength(2)
    expect(diffs[0]?.oldText).toBe('line4')
    expect(diffs[0]?.newText).toBe('A')
    expect(diffs[1]?.oldText).toBe('line36')
    expect(diffs[1]?.newText).toBe('B')
  })
})

describe('diffsFromMeta (defensive narrowing)', () => {
  // The narrowing accepts an opaque JsonValue; a malformed payload is not a
  // statically-valid JsonValue, so route every case through one cast helper that
  // mirrors how a hand-edited/older session log delivers arbitrary shapes.
  const m = (value: unknown): JsonValue | undefined => value as JsonValue | undefined
  const good = { diffs: [{ path: 'f.txt', oldText: 'a', newText: 'b' }] }

  it('narrows a well-formed { diffs } payload', () => {
    expect(diffsFromMeta(m(good))).toEqual(good.diffs)
  })

  it('accepts a diff whose oldText is null (a create-style hunk)', () => {
    const meta = { diffs: [{ path: 'f.txt', oldText: null, newText: 'x' }] }
    expect(diffsFromMeta(m(meta))).toEqual(meta.diffs)
  })

  it('rejects undefined / non-object / array meta', () => {
    expect(diffsFromMeta(undefined)).toBeUndefined()
    expect(diffsFromMeta(null)).toBeUndefined()
    expect(diffsFromMeta(m('nope'))).toBeUndefined()
    expect(diffsFromMeta(m([]))).toBeUndefined()
  })

  it('rejects a missing / empty / non-array diffs field', () => {
    expect(diffsFromMeta(m({}))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: 'x' }))).toBeUndefined()
  })

  it('rejects a diffs array containing a malformed entry', () => {
    expect(diffsFromMeta(m({ diffs: [{ path: 'f.txt', oldText: 'a' }] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [{ path: 1, oldText: 'a', newText: 'b' }] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [{ path: 'f', oldText: 5, newText: 'b' }] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [{ path: 'f', oldText: 'a', newText: 7 }] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [null] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: ['x'] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [[]] }))).toBeUndefined()
  })
})
