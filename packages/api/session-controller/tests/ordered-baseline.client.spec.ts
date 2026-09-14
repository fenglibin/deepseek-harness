/**
 * Ordered-baseline merge: the pure function behind every Session-list refresh
 * after the first. Its contract is that established rows never move relative to
 * each other, so a refresh cannot reorder the sidebar under the operator.
 */

import { describe, expect, it } from 'vitest'
import { mergeOrderedBaseline } from '../src/client/ordered-baseline.ts'

/**
 * Rows carry the baseline's value for their identity, so a test can tell which
 * side a returned row came from.
 * @param id - row identity.
 * @param tag - which side supplied the value.
 * @returns one row.
 */
const row = (id: string, tag = 'baseline'): { id: string; tag: string } => ({ id, tag })

const idsOf = (rows: readonly { id: string }[]): string[] => rows.map(value => value.id)
const keyOf = (value: { id: string }): string => value.id

describe('mergeOrderedBaseline', () => {
  it('keeps the established relative order of known rows and takes baseline values', async () => {
    const current = [row('a', 'client'), row('b', 'client'), row('c', 'client')]
    const baseline = [row('c'), row('b'), row('a')]

    const merged = mergeOrderedBaseline(current, baseline, keyOf)

    expect(idsOf(merged)).toEqual(['a', 'b', 'c'])
    expect(merged.every(value => value.tag === 'baseline')).toBe(true)
  })

  it('drops rows the baseline no longer carries', async () => {
    const merged = mergeOrderedBaseline(
      [row('a'), row('gone'), row('b')],
      [row('a'), row('b')],
      keyOf,
    )
    expect(idsOf(merged)).toEqual(['a', 'b'])
  })

  it('inserts a new row ahead of the nearest following known row', async () => {
    // "new" precedes "known" in the baseline, so it lands immediately before it
    // rather than at the end.
    const merged = mergeOrderedBaseline([row('known')], [row('new'), row('known')], keyOf)
    expect(idsOf(merged)).toEqual(['new', 'known'])
  })

  it('appends a new row that follows every known row', async () => {
    const merged = mergeOrderedBaseline([row('known')], [row('known'), row('new')], keyOf)
    expect(idsOf(merged)).toEqual(['known', 'new'])
  })

  it('keeps baseline order inside one inserted run', async () => {
    const merged = mergeOrderedBaseline(
      [row('known')],
      [row('new-1'), row('new-2'), row('known'), row('new-3'), row('new-4')],
      keyOf,
    )
    expect(idsOf(merged)).toEqual(['new-1', 'new-2', 'known', 'new-3', 'new-4'])
  })

  it('matches a naive merge over randomized inputs', async () => {
    // The reference is the quadratic-to-cubic form this replaced: insert each
    // new baseline row ahead of the nearest following KNOWN row, scanning
    // forward each time. Asserting agreement across randomized overlap and
    // orderings is what makes the linear rewrite safe to ship.
    const naive = (current: readonly { id: string }[], baseline: readonly { id: string }[]): string[] => {
      const byKey = new Map(baseline.map(value => [keyOf(value), value]))
      const merged = current.map(value => byKey.get(keyOf(value)))
        .filter((value): value is { id: string } => value !== undefined)
      const seen = new Set(merged.map(keyOf))
      for (let index = 0; index < baseline.length; index += 1) {
        const value = baseline[index] as { id: string }
        if (seen.has(keyOf(value))) continue
        let insertion = merged.length
        for (let following = index + 1; following < baseline.length; following += 1) {
          const candidate = baseline[following] as { id: string }
          const known = merged.findIndex(item => keyOf(item) === keyOf(candidate))
          if (known !== -1) {
            insertion = known
            break
          }
        }
        merged.splice(insertion, 0, value)
        seen.add(keyOf(value))
      }
      return merged.map(keyOf)
    }

    let seed = 12345
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % bound
    }
    const shuffle = (input: readonly string[]): string[] => {
      const out = [...input]
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = next(i + 1)
        const a = out[i] as string
        out[i] = out[j] as string
        out[j] = a
      }
      return out
    }

    for (let trial = 0; trial < 500; trial += 1) {
      const all = Array.from({ length: next(14) }, (_, index) => `s${index}`)
      const baseline = shuffle(all.filter(() => next(4) !== 0)).map(id => row(id))
      const current = shuffle(all.filter(() => next(3) !== 0)).map(id => row(id, 'client'))
      expect(idsOf(mergeOrderedBaseline(current, baseline, keyOf)))
        .toEqual(naive(current, baseline))
    }
  })
})
