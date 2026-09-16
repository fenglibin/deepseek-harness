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
  return { path, before, after, operation }
}

describe('SessionRevisionStore', () => {
  it('credits a subagent change to the root session', () => {
    const store = new SessionRevisionStore(parentMap({ [CHILD]: ROOT }))
    store.record(CHILD, mutation('/w/a.txt', 'base\n', 'changed\n'), 5)
    const listed = store.list(ROOT)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.baseline).toBe('base\n')
  })

  it('aggregates a grandchild through its parent', () => {
    const store = new SessionRevisionStore(parentMap({ [CHILD]: ROOT, [GRANDCHILD]: CHILD }))
    store.record(GRANDCHILD, mutation('/w/a.txt', 'base\n', 'changed\n'), 5)
    expect(store.list(ROOT)).toHaveLength(1)
  })

  it('keeps each session own changes visible under itself', () => {
    const store = new SessionRevisionStore(parentMap({}))
    store.record(ROOT, mutation('/w/a.txt', 'base\n', 'changed\n'), 5)
    expect(store.list(ROOT)).toHaveLength(1)
  })

  it('orders revisions by first mutation', () => {
    const store = new SessionRevisionStore(parentMap({}))
    store.record(ROOT, mutation('/w/second.txt', 'b\n', 'B\n'), 20)
    store.record(ROOT, mutation('/w/first.txt', 'a\n', 'A\n'), 10)
    expect(store.list(ROOT).map(entry => entry.path)).toEqual(['/w/first.txt', '/w/second.txt'])
  })

  it('merges a parent and child touching the same path into one record', () => {
    const store = new SessionRevisionStore(parentMap({ [CHILD]: ROOT }))
    store.record(ROOT, mutation('/w/a.txt', 'base\n', 'mid\n'), 10)
    store.record(CHILD, mutation('/w/a.txt', 'mid\n', 'final\n'), 20)
    const listed = store.list(ROOT)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.baseline).toBe('base\n')
    expect(listed[0]?.endState).toBe('final\n')
  })

  it('forgets a session records', () => {
    const store = new SessionRevisionStore(parentMap({}))
    store.record(ROOT, mutation('/w/a.txt', 'base\n', 'changed\n'), 5)
    store.forget(ROOT)
    expect(store.list(ROOT)).toEqual([])
  })
})

describe('mergeRevisions', () => {
  const earlier: FileRevision = {
    path: '/w/a.txt', baseline: 'base\n', endState: 'mid\n', operation: 'write', firstSeq: 10, lastSeq: 10,
  }
  const later: FileRevision = {
    path: '/w/a.txt', baseline: 'mid\n', endState: 'final\n', operation: 'edit', firstSeq: 20, lastSeq: 20,
  }

  it('keeps the earlier baseline and the later end state', () => {
    expect(mergeRevisions(earlier, later)).toMatchObject({
      baseline: 'base\n', endState: 'final\n', firstSeq: 10, lastSeq: 20,
    })
  })

  it('is order-independent', () => {
    expect(mergeRevisions(later, earlier)).toEqual(mergeRevisions(earlier, later))
  })

  it('returns the other record when one side is absent', () => {
    expect(mergeRevisions(undefined, later)).toBe(later)
  })
})
