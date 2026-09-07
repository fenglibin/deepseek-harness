import { describe, expect, it } from 'vitest'
import { normalizeDraft, type PromptCommandEntry } from '../src/client/controller.ts'

function draft(partial: Partial<PromptCommandEntry> = {}): PromptCommandEntry {
  return {
    name: 'code-review',
    prompt: 'Review this diff',
    ...partial,
  }
}

describe('normalizeDraft', () => {
  it('trims required fields and drops a blank title', () => {
    expect(normalizeDraft(draft({
      name: '  code-review  ',
      title: '   ',
      prompt: ' Review ',
    }))).toEqual({
      name: 'code-review',
      prompt: 'Review',
    })
  })

  it('keeps a non-blank title', () => {
    expect(normalizeDraft(draft({ title: ' 代码审查 ' }))).toEqual({
      name: 'code-review',
      title: '代码审查',
      prompt: 'Review this diff',
    })
  })

  it('returns undefined when a required field is blank', () => {
    expect(normalizeDraft(draft({ name: '  ' }))).toBeUndefined()
    expect(normalizeDraft(draft({ prompt: '   ' }))).toBeUndefined()
  })

  it('returns undefined when the name is not a lowercase hyphenated identifier', () => {
    expect(normalizeDraft(draft({ name: 'Code Review' }))).toBeUndefined()
    expect(normalizeDraft(draft({ name: 'Code' }))).toBeUndefined()
    expect(normalizeDraft(draft({ name: '代码审查' }))).toBeUndefined()
    expect(normalizeDraft(draft({ name: 'code_review' }))).toEqual(expect.objectContaining({ name: 'code_review' }))
  })
})
