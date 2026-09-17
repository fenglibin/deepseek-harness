/**
 * Behavior specs for mutation capture: which settled tool results carry a
 * mutation, and what the folded record keeps.
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { captureMutation, foldMutation, type CapturedMutation } from '../src/capture.ts'
import type { RevisionOrder } from '../src/types.ts'

const S1 = 's1' as SessionId

/** A position at one instant, from one session. */
function order(seq: number, at = 1_000, session: SessionId = S1): RevisionOrder {
  return { session, at, seq }
}

describe('captureMutation', () => {
  it('captures a write with both content sides', () => {
    expect(captureMutation('write', {
      path: '/w/a.txt', before: 'old\n', after: 'new\n', operation: 'update',
    })).toEqual({
      path: '/w/a.txt', baseline: 'old\n', origin: 'existing', after: 'new\n', operation: 'write',
    })
  })

  it('treats a reported create as an absent baseline', () => {
    expect(captureMutation('write', { path: '/w/a.txt', before: null, after: 'new\n', operation: 'create' }))
      .toEqual({ path: '/w/a.txt', baseline: null, origin: 'absent', after: 'new\n', operation: 'write' })
  })

  it('treats an overwrite with no captured prior content as an unknown baseline', () => {
    // The storage backend reports a null `before` for an overwrite at or above
    // its presentation bound, or for binary/non-UTF-8/unreadable content. The
    // file existed, so this must not be read as a create — a revert that
    // deleted it would destroy content this session never made.
    expect(captureMutation('write', { path: '/w/big.bin', before: null, after: 'NEW\n', operation: 'update' }))
      .toEqual({ path: '/w/big.bin', baseline: null, origin: 'unknown', after: 'NEW\n', operation: 'write' })
  })

  it('classifies an edit as edit', () => {
    expect(captureMutation('edit', { path: '/w/a.txt', before: 'b\n', after: 'a\n' })?.operation).toBe('edit')
  })

  it('captures a str_replace_editor mutation with both content sides', () => {
    // The editor reports the same pair as write/edit, which is what makes its
    // changes viewable and revertible instead of merely listed.
    expect(captureMutation('str_replace_editor', {
      path: '/w/a.txt', text: 'ok', before: 'old\n', after: 'new\n', operation: 'update',
    })).toEqual({
      path: '/w/a.txt', baseline: 'old\n', origin: 'existing', after: 'new\n', operation: 'edit',
    })
  })

  it('treats an editor create as an absent baseline', () => {
    expect(captureMutation('str_replace_editor', {
      path: '/w/made.txt', text: 'ok', before: null, after: 'fresh\n', operation: 'create',
    })).toEqual({
      path: '/w/made.txt', baseline: null, origin: 'absent', after: 'fresh\n', operation: 'edit',
    })
  })

  it('treats an editor overwrite with no captured prior content as unknown', () => {
    expect(captureMutation('str_replace_editor', {
      path: '/w/big.bin', text: 'ok', before: null, after: 'NEW\n', operation: 'update',
    })).toEqual({
      path: '/w/big.bin', baseline: null, origin: 'unknown', after: 'NEW\n', operation: 'edit',
    })
  })

  it('ignores a read-only editor result', () => {
    // `view` reports path and text only. There is no mutation to record, and
    // recording one would put a read into the changed-file list.
    expect(captureMutation('str_replace_editor', { path: '/w/a.txt', text: 'contents' })).toBeNull()
  })

  it('ignores a tool that does not mutate files', () => {
    expect(captureMutation('read', { path: '/w/a.txt', after: 'x\n' })).toBeNull()
  })

  it('ignores a result missing the after side', () => {
    expect(captureMutation('write', { path: '/w/a.txt', before: 'x\n' })).toBeNull()
  })

  it('ignores an edit that reports no prior content', () => {
    // An edit schema requires `before`, so a missing one is not a create.
    expect(captureMutation('edit', { path: '/w/a.txt', before: null, after: 'x\n' })).toBeNull()
  })

  it('ignores a result with no path', () => {
    expect(captureMutation('write', { before: 'x\n', after: 'y\n' })).toBeNull()
  })

  it('ignores a non-object value', () => {
    expect(captureMutation('write', 'nonsense')).toBeNull()
  })
})

describe('foldMutation', () => {
  const first: CapturedMutation = {
    path: '/w/a.txt', baseline: 'base\n', origin: 'existing', after: 'one\n', operation: 'write',
  }
  const second: CapturedMutation = {
    path: '/w/a.txt', baseline: 'one\n', origin: 'existing', after: 'two\n', operation: 'edit',
  }

  it('fixes the baseline at the first mutation', () => {
    const record = foldMutation(undefined, first, order(10))
    expect(record.baseline).toBe('base\n')
    expect(record.origin).toBe('existing')
    expect(record.firstOrder).toEqual(order(10))
    expect(record.lastOrder).toEqual(order(10))
  })

  it('advances only the end state on a later mutation', () => {
    const record = foldMutation(foldMutation(undefined, first, order(10)), second, order(20))
    expect(record.baseline).toBe('base\n')
    expect(record.endState).toBe('two\n')
    expect(record.operation).toBe('write')
    expect(record.firstOrder).toEqual(order(10))
    expect(record.lastOrder).toEqual(order(20))
  })

  it('folds out-of-order arrivals by seq, so the oldest mutation owns the baseline', () => {
    // The session genuinely wrote base→one at seq 10 and then one→two at seq
    // 20, but the results settle in the opposite order. The oldest mutation's
    // `before` is the session's real starting point, so folding by seq must
    // recover `base`, not the later mutation's `one`.
    const arriveLate = foldMutation(foldMutation(undefined, second, order(20)), first, order(10))
    const arriveInOrder = foldMutation(foldMutation(undefined, first, order(10)), second, order(20))
    expect(arriveLate).toEqual(arriveInOrder)
    expect(arriveLate.baseline).toBe('base\n')
    expect(arriveLate.endState).toBe('two\n')
    expect(arriveLate.firstOrder).toEqual(order(10))
    expect(arriveLate.lastOrder).toEqual(order(20))
  })

  it('keeps a captured baseline when a later bulk overwrite could not report one', () => {
    // The session read the file at seq 10 and then overwrote it with content
    // too large to buffer at seq 20. The honest baseline is still the seq-10
    // content, so the record must stay revertible rather than degrade.
    const bulk: CapturedMutation = {
      path: '/w/a.txt', baseline: null, origin: 'unknown', after: 'huge\n', operation: 'write',
    }
    const record = foldMutation(foldMutation(undefined, first, order(10)), bulk, order(20))
    expect(record.baseline).toBe('base\n')
    expect(record.origin).toBe('existing')
    expect(record.endState).toBe('huge\n')
  })

  it('does not let a later unknown-capture mutation erase an earlier baseline', () => {
    const bulk: CapturedMutation = {
      path: '/w/a.txt', baseline: null, origin: 'unknown', after: 'huge\n', operation: 'write',
    }
    const record = foldMutation(undefined, bulk, order(30))
    expect(record.origin).toBe('unknown')
    // An older, usable capture still wins the baseline.
    const earlier = foldMutation(record, first, order(10))
    expect(earlier.baseline).toBe('base\n')
    expect(earlier.origin).toBe('existing')
  })
})
