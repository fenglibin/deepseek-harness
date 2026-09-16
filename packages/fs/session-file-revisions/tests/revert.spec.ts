/**
 * Behavior specs for the reverse-patch revert: what a revert does to a file
 * whose current content may already carry changes this session did not make.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { revertContent } from '../src/revert.ts'

describe('revertContent', () => {
  it('restores the baseline when the file still holds the session end state', () => {
    const result = revertContent('a\nb\nc\n', 'a\nB\nc\n', 'a\nB\nc\n')
    expect(result).toEqual({ applied: 'all', content: 'a\nb\nc\n' })
  })

  it('keeps an external edit made elsewhere in the same file', () => {
    const result = revertContent(
      'a\nb\nc\nd\ne\n',
      'a\nB\nc\nd\ne\n',
      'a\nB\nc\nd\nE-USER\n',
    )
    expect(result).toEqual({ applied: 'all', content: 'a\nb\nc\nd\nE-USER\n' })
  })

  it('reverts every session hunk while keeping a later external insertion', () => {
    const result = revertContent(
      'a\nb\nc\nd\ne\nf\ng\n',
      'a\nB\nc\nd\nE\nf\ng\n',
      'a\nB\nc\nd\nE\nf\nG-USER\n',
    )
    expect(result).toEqual({ applied: 'all', content: 'a\nb\nc\nd\ne\nf\nG-USER\n' })
  })

  it('refuses to write when the session and an outsider changed the same line', () => {
    const result = revertContent('x\ny\nz\n', 'X-AGENT\ny\nz\n', 'X-USER\ny\nz\n')
    expect(result).toEqual({ applied: 'none' })
  })

  it('applies the hunks that still match and reports the rest', () => {
    const baseline = 'h1a\nh1b\n\n\n\n\nmiddle\n\n\n\n\nh2a\nh2b\n'
    const endState = 'H1A\nh1b\n\n\n\n\nmiddle\n\n\n\n\nH2A\nh2b\n'
    const current = 'H1A\nh1b\n\n\n\n\nmiddle\n\n\n\n\nH2A\nh2b-USER\n'
    const result = revertContent(baseline, endState, current)
    expect(result.applied).toBe('partial')
    if (result.applied !== 'partial') return
    expect(result.skipped).toBe(1)
    // The reverted hunk is back to its baseline and the external edit survives.
    expect(result.content).toBe('h1a\nh1b\n\n\n\n\nmiddle\n\n\n\n\nH2A\nh2b-USER\n')
  })

  it('treats a null baseline as reverting to nothing', () => {
    const result = revertContent(null, 'created\n', 'created\n')
    expect(result).toEqual({ applied: 'all', content: '' })
  })

  it('reports no application when the baseline already matches the end state', () => {
    const result = revertContent('a\nb\n', 'a\nb\n', 'a\nb\n')
    expect(result).toEqual({ applied: 'all', content: 'a\nb\n' })
  })
})
