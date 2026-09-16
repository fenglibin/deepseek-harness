/**
 * Behavior specs for mutation capture: which settled tool results carry a
 * mutation, and what the folded record keeps.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { captureMutation, foldMutation } from '../src/capture.ts'

describe('captureMutation', () => {
  it('captures a write with both content sides', () => {
    expect(captureMutation('write', {
      path: '/w/a.txt', before: 'old\n', after: 'new\n', operation: 'update',
    })).toEqual({ path: '/w/a.txt', before: 'old\n', after: 'new\n', operation: 'write' })
  })

  it('treats a missing before as a create', () => {
    const captured = captureMutation('write', { path: '/w/a.txt', before: null, after: 'new\n' })
    expect(captured).toEqual({ path: '/w/a.txt', before: null, after: 'new\n', operation: 'write' })
  })

  it('classifies an edit as edit', () => {
    const captured = captureMutation('edit', { path: '/w/a.txt', before: 'b\n', after: 'a\n' })
    expect(captured?.operation).toBe('edit')
  })

  it('ignores a tool that does not mutate files', () => {
    expect(captureMutation('read', { path: '/w/a.txt', after: 'x\n' })).toBeNull()
  })

  it('ignores a result missing the after side', () => {
    expect(captureMutation('write', { path: '/w/a.txt', before: 'x\n' })).toBeNull()
  })

  it('ignores a result with no path', () => {
    expect(captureMutation('write', { before: 'x\n', after: 'y\n' })).toBeNull()
  })

  it('ignores a non-object value', () => {
    expect(captureMutation('write', 'nonsense')).toBeNull()
  })
})

describe('foldMutation', () => {
  const first = { path: '/w/a.txt', before: 'base\n', after: 'one\n', operation: 'write' as const }
  const second = { path: '/w/a.txt', before: 'one\n', after: 'two\n', operation: 'edit' as const }

  it('fixes the baseline at the first mutation', () => {
    const record = foldMutation(undefined, first, 10)
    expect(record.baseline).toBe('base\n')
    expect(record.firstSeq).toBe(10)
    expect(record.lastSeq).toBe(10)
  })

  it('advances only the end state on a later mutation', () => {
    const record = foldMutation(foldMutation(undefined, first, 10), second, 20)
    expect(record.baseline).toBe('base\n')
    expect(record.endState).toBe('two\n')
    expect(record.operation).toBe('write')
    expect(record.firstSeq).toBe(10)
    expect(record.lastSeq).toBe(20)
  })

  it('folds out-of-order arrivals by seq, never moving the end state backwards', () => {
    const late = foldMutation(foldMutation(undefined, first, 20), second, 10)
    expect(late.baseline).toBe('base\n')
    expect(late.endState).toBe('one\n')
    expect(late.lastSeq).toBe(20)
  })
})
