import { describe, expect, it } from 'vitest'
import {
  GRADING_CHARACTER_FLOOR,
  gradeByLength,
  parseGradedLevel,
} from '../src/grading.ts'

/** Text of an exact length. */
function filler(length: number): string {
  return '啊'.repeat(length)
}

describe('gradeByLength', () => {
  it('classifies a request past the floor as l2', () => {
    expect(gradeByLength(filler(GRADING_CHARACTER_FLOOR + 1), GRADING_CHARACTER_FLOOR)).toBe('l2')
  })

  it('leaves a request at the floor to the model', () => {
    // The floor is "longer than", not "at least": a request exactly at the
    // boundary is still small enough to be judged on its meaning.
    expect(gradeByLength(filler(GRADING_CHARACTER_FLOOR), GRADING_CHARACTER_FLOOR)).toBeUndefined()
  })

  it('leaves a short request to the model', () => {
    expect(gradeByLength('fix the typo', GRADING_CHARACTER_FLOOR)).toBeUndefined()
  })

  it('honours a configured floor', () => {
    // The floor is a deployment setting, so the comparison has to use it
    // rather than the built-in default.
    expect(gradeByLength('12345', 4)).toBe('l2')
    expect(gradeByLength('1234', 4)).toBeUndefined()
  })

  it('grades an empty objective as the model’s to decide', () => {
    expect(gradeByLength('', GRADING_CHARACTER_FLOOR)).toBeUndefined()
  })

  it('counts characters, not bytes', () => {
    // A CJK objective is far shorter in characters than in UTF-8 bytes; the
    // floor is stated in characters, so the comparison must be too.
    expect(gradeByLength(filler(GRADING_CHARACTER_FLOOR), GRADING_CHARACTER_FLOOR)).toBeUndefined()
  })
})

describe('parseGradedLevel', () => {
  it('reads a bare label', () => {
    expect(parseGradedLevel('l2')).toBe('l2')
  })

  it('ignores case and surrounding whitespace', () => {
    expect(parseGradedLevel('  L1\n')).toBe('l1')
  })

  it('reads a label wrapped in markdown emphasis', () => {
    expect(parseGradedLevel('**l0**')).toBe('l0')
  })

  it('prefers a label standing alone over one named in prose', () => {
    // "this is not l2, it is l1" names both tiers; the line that holds only a
    // label is the actual answer.
    expect(parseGradedLevel('This is not l2.\nl1')).toBe('l1')
  })

  it('falls back to the first label when no line stands alone', () => {
    expect(parseGradedLevel('I would call this l1 because it needs a design.')).toBe('l1')
  })

  it('does not read a label out of a longer identifier', () => {
    // `\b` is a word boundary, not a path boundary, so a segment such as
    // `src/l0/fixture` does read as a label. What must not happen is a label
    // being found inside a longer token, which is what `l2x` would be.
    expect(parseGradedLevel('the l2x branch answered nothing')).toBeUndefined()
    expect(parseGradedLevel('l10n ready')).toBeUndefined()
  })

  it('reports no tier when the response names none', () => {
    expect(parseGradedLevel('I cannot tell')).toBeUndefined()
    expect(parseGradedLevel('')).toBeUndefined()
  })
})
