import { describe, expect, it } from 'vitest'
import { normalizeDraft, type PromptCommandEntry } from '../src/client/controller.ts'

function draft(partial: Partial<PromptCommandEntry> = {}): PromptCommandEntry {
  return {
    name: 'code-review',
    description: 'review the diff',
    prompt: 'Review this diff',
    ...partial,
  }
}

describe('normalizeDraft', () => {
  it('trims required fields and drops blank optional fields', () => {
    expect(normalizeDraft(draft({
      name: '  code-review  ',
      title: '   ',
      description: ' review ',
      prompt: ' Review ',
      hint: '  ',
    }))).toEqual({
      name: 'code-review',
      description: 'review',
      prompt: 'Review',
    })
  })

  it('keeps non-blank optional fields', () => {
    expect(normalizeDraft(draft({ title: ' 代码审查 ', hint: ' focus ' }))).toEqual({
      name: 'code-review',
      title: '代码审查',
      description: 'review the diff',
      prompt: 'Review this diff',
      hint: 'focus',
    })
  })

  it('returns undefined when a required field is blank', () => {
    expect(normalizeDraft(draft({ name: '  ' }))).toBeUndefined()
    expect(normalizeDraft(draft({ description: '' }))).toBeUndefined()
    expect(normalizeDraft(draft({ prompt: '   ' }))).toBeUndefined()
  })

  it('returns undefined when the name is not a lowercase hyphenated identifier', () => {
    expect(normalizeDraft(draft({ name: 'Code Review' }))).toBeUndefined()
    expect(normalizeDraft(draft({ name: 'Code' }))).toBeUndefined()
    expect(normalizeDraft(draft({ name: '代码审查' }))).toBeUndefined()
    expect(normalizeDraft(draft({ name: 'code_review' }))).toEqual(expect.objectContaining({ name: 'code_review' }))
  })
})
