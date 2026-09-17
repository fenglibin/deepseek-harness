/**
 * Behavior specs for per-session storage: subagent aggregation and the merge of
 * two sessions' records for one path.
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { mergeRevisions, SessionRevisionStore } from '../src/registry.ts'
import type { FileRevision } from '../src/types.ts'

const ROOT = 'session-root' as SessionId
const CHILD = 'session-child' as SessionId
const GRANDCHILD = 'session-grandchild' as SessionId

/** A parent lookup from a fixed map. */
function parentMap(entries: Readonly<Record<string, string>>): (id: SessionId) => SessionId | undefined {
  return id => entries[id] as SessionId | undefined
}

function mutation(path: string, before: string | null, after: string, operation: 'write' | 'edit' = 'write') {
  return {
    path, baseline: before, origin: before === null ? 'absent' as const : 'existing' as const, after, operation,
  }
}

describe('SessionRevisionStore', () => {
  it('credits a subagent change to the root session', () => {
    const store = new SessionRevisionStore(parentMap({ [CHILD]: ROOT }))
    store.record(CHILD, mutation('/w/a.txt', 'base\n', 'changed\n'), { session: CHILD, at: 10, seq: 5 })
    const listed = store.list(ROOT)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.baseline).toBe('base\n')
  })

  it('aggregates a grandchild through its parent', () => {
    const store = new SessionRevisionStore(parentMap({ [CHILD]: ROOT, [GRANDCHILD]: CHILD }))
    store.record(GRANDCHILD, mutation('/w/a.txt', 'base\n', 'changed\n'), { session: GRANDCHILD, at: 10, seq: 5 })
    expect(store.list(ROOT)).toHaveLength(1)
  })

  it('keeps each session own changes visible under itself', () => {
    const store = new SessionRevisionStore(parentMap({}))
    store.record(ROOT, mutation('/w/a.txt', 'base\n', 'changed\n'), { session: ROOT, at: 10, seq: 5 })
    expect(store.list(ROOT)).toHaveLength(1)
  })

  it('orders revisions by first mutation', () => {
    const store = new SessionRevisionStore(parentMap({}))
    store.record(ROOT, mutation('/w/second.txt', 'b\n', 'B\n'), { session: ROOT, at: 20, seq: 2 })
    store.record(ROOT, mutation('/w/first.txt', 'a\n', 'A\n'), { session: ROOT, at: 10, seq: 1 })
    expect(store.list(ROOT).map(entry => entry.path)).toEqual(['/w/first.txt', '/w/second.txt'])
  })

  it('merges a parent and child touching the same path into one record', () => {
    const store = new SessionRevisionStore(parentMap({ [CHILD]: ROOT }))
    store.record(ROOT, mutation('/w/a.txt', 'base\n', 'mid\n'), { session: ROOT, at: 10, seq: 10 })
    store.record(CHILD, mutation('/w/a.txt', 'mid\n', 'final\n'), { session: CHILD, at: 20, seq: 105 })
    const listed = store.list(ROOT)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.baseline).toBe('base\n')
    expect(listed[0]?.endState).toBe('final\n')
  })

  it('bounds a parent and child by time, not by their incomparable seq numbers', () => {
    // The child is forked from a parent log, so its own seq restarts near the
    // seed length. Here the child settles LATER while carrying a SMALLER seq.
    // Ordering on seq would take the child's baseline as the earlier side and
    // leave the end state at the parent's value, losing the path's change.
    const store = new SessionRevisionStore(parentMap({ [CHILD]: ROOT }))
    store.record(ROOT, mutation('/w/a.txt', 'base\n', 'mid\n'), { session: ROOT, at: 100, seq: 100 })
    store.record(CHILD, mutation('/w/a.txt', 'mid\n', 'final\n'), { session: CHILD, at: 200, seq: 50 })
    const [listed] = store.list(ROOT)
    expect(listed?.baseline).toBe('base\n')
    expect(listed?.endState).toBe('final\n')
  })

  it('forgets a session records', () => {
    const store = new SessionRevisionStore(parentMap({}))
    store.record(ROOT, mutation('/w/a.txt', 'base\n', 'changed\n'), { session: ROOT, at: 10, seq: 5 })
    store.forget(ROOT)
    expect(store.list(ROOT)).toEqual([])
  })
})

describe('mergeRevisions', () => {
  const earlier: FileRevision = {
    path: '/w/a.txt', baseline: 'base\n', origin: 'existing', endState: 'mid\n',
    operation: 'write', firstOrder: { session: ROOT, at: 10, seq: 10 }, lastOrder: { session: ROOT, at: 10, seq: 10 },
  }
  const later: FileRevision = {
    path: '/w/a.txt', baseline: 'mid\n', origin: 'existing', endState: 'final\n',
    operation: 'edit', firstOrder: { session: CHILD, at: 20, seq: 20 }, lastOrder: { session: CHILD, at: 20, seq: 20 },
  }

  it('keeps the earlier baseline and the later end state', () => {
    expect(mergeRevisions(earlier, later)).toMatchObject({
      baseline: 'base\n', endState: 'final\n',
    })
  })

  it('is order-independent', () => {
    expect(mergeRevisions(later, earlier)).toEqual(mergeRevisions(earlier, later))
  })

  it('returns the other record when one side is absent', () => {
    expect(mergeRevisions(undefined, later)).toBe(later)
  })

  it('keeps the origin of whichever side owns the baseline', () => {
    const created: FileRevision = {
      ...earlier, baseline: null, origin: 'absent',
    }
    const merged = mergeRevisions(created, later)
    expect(merged.origin).toBe('absent')
    expect(merged.baseline).toBeNull()
  })
})
