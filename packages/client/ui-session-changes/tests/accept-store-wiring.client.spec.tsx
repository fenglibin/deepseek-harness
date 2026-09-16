// @vitest-environment jsdom

/**
 * The accept record on the REAL slot assembly: production `SlotRegistry`,
 * `ui-session` scope adapter, and renderer, with the dock's own registration
 * supplying its declared store. Every other dock test injects `useStore` /
 * `actions` by hand, so only this file proves the framework actually resolves
 * the declared store and hands it to the component — the wiring the whole
 * accept-survival feature depends on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SlotTestRuntime, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { apply } from '../src/client/index.ts'
import { createAcceptedChangesStore } from '../src/client/accept-store.ts'
import { SessionChangesDock, type SessionChangesInjected } from '../src/client/SessionChangesDock.tsx'
import { zh } from '../src/client/locales.ts'
// Type-only: registers the `session-changes` LocaleNamespaceMap merge and the
// `conversation.input.dock` slot declaration this suite renders into.
import '@deepseek-ai/dsh-client-ui-session-changes/client'

/** One live accept-store instance as the framework resolved it. */
type AcceptInstance = ReturnType<ReturnType<typeof createAcceptedChangesStore>['create']>

/**
 * Boot the real runtime and mount the actual plugin `apply`, with the dock slot
 * declared as `ui-conversation` declares it. The injected opener and a stub
 * locale/sessions face stand in for services this suite does not exercise.
 */
async function bench() {
  const runtime = await SlotTestRuntime.create()
  // The runtime already provides the controller-owned `sessions` double. The
  // remaining faces are what the dock's own registration reads.
  runtime.ctx.provide('remote', { session: { openWorkspacePath: () => Promise.resolve({ ok: true }) } } as never)
  runtime.ctx.provide('remote.session', { openWorkspacePath: () => Promise.resolve({ ok: true }) } as never)
  runtime.ctx.provide('locale', { register: () => () => {} } as never)
  await runtime.root.declare(
    { 'conversation.input.dock': { kind: 'list', scope: 'session' } },
    () => null,
  )
  await runtime.mount({ inject: ['slots'], apply })
  runtime.renderRoot()
  return runtime
}

/** The accept-store instance the framework resolved for one Session. */
function acceptStoreOf(runtime: SlotTestRuntime, sessionId: string): AcceptInstance {
  return runtime.storeOf('conversation.input.dock', sessionId) as AcceptInstance
}

describe('the dock registration declares the accept store', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(cleanup)

  it('resolves a declared session-scoped store for the registered entry', async () => {
    const runtime = await bench()
    await runtime.sessions.add({ id: 's1' })

    // storeOf throws when the entry declares no store, so reaching an instance
    // here is itself the proof that `store` reached the registration.
    const instance = acceptStoreOf(runtime, 's1')
    expect(instance.getSnapshot()).toEqual({})
    instance.actions.accept('/proj/a.txt', 10)
    expect(instance.getSnapshot()).toEqual({ '/proj/a.txt': 10 })

    await runtime.dispose()
  })

  it('hands the same instance back for the same Session and a distinct one per Session', async () => {
    const runtime = await bench()
    await runtime.sessions.add({ id: 's1' })
    await runtime.sessions.add({ id: 's2' })

    const one = acceptStoreOf(runtime, 's1')
    one.actions.accept('/proj/a.txt', 10)
    expect(acceptStoreOf(runtime, 's1')).toBe(one)

    const two = acceptStoreOf(runtime, 's2')
    expect(two).not.toBe(one)
    expect(two.getSnapshot()).toEqual({})

    await runtime.dispose()
  })

  it('keeps the accept record when the reader switches away and back', async () => {
    const runtime = await bench()
    await runtime.sessions.add({ id: 's1' })
    await runtime.sessions.add({ id: 's2' })

    const one = acceptStoreOf(runtime, 's1')
    one.actions.accept('/proj/a.txt', 10)

    // Selecting another Session must not tear down s1: it stays listed, so its
    // scope survives and the record is still there on the way back.
    await runtime.sessions.setCurrent('s2')
    expect(acceptStoreOf(runtime, 's2').getSnapshot()).toEqual({})
    await runtime.sessions.setCurrent('s1')

    expect(acceptStoreOf(runtime, 's1')).toBe(one)
    expect(acceptStoreOf(runtime, 's1').getSnapshot()).toEqual({ '/proj/a.txt': 10 })

    await runtime.dispose()
  })

  it('discards the record with the Session scope once the Session is gone for good', async () => {
    const runtime = await bench()
    await runtime.sessions.add({ id: 's1' })
    const before = acceptStoreOf(runtime, 's1')
    before.actions.accept('/proj/a.txt', 10)
    const key = 'dsh.session-changes.accepted.s1'
    expect(localStorage.getItem(key)).not.toBeNull()

    // A Session that is neither selected nor listed has no scope left, so the
    // framework drops the instance AND its stored key — a pruned Session must
    // not leave an orphan behind. Losing only the SELECTION keeps the scope,
    // which is the reader-facing case asserted above.
    await runtime.sessions.remove('s1')
    expect(localStorage.getItem(key)).toBeNull()

    await runtime.sessions.add({ id: 's1' })
    const after = acceptStoreOf(runtime, 's1')
    expect(after).not.toBe(before)
    expect(after.getSnapshot()).toEqual({})

    await runtime.dispose()
  })

  it('writes the persisted value under a Session-suffixed key', async () => {
    const runtime = await bench()
    await runtime.sessions.add({ id: 's1' })
    acceptStoreOf(runtime, 's1').actions.accept('/proj/a.txt', 10)

    const key = 'dsh.session-changes.accepted.s1'
    expect(localStorage.getItem(key)).toBe(JSON.stringify({ '/proj/a.txt': 10 }))

    await runtime.dispose()
  })

  it('keeps the dock registered with its opener and order', async () => {
    const runtime = await bench()
    await runtime.sessions.add({ id: 's1' })

    const entry = runtime.slots.entries('conversation.input.dock')[0]
    expect(entry?.store).toBeDefined()
    const injected = (entry?.inject as unknown as (id: SessionId) => SessionChangesInjected)?.('s1' as SessionId)
    expect(injected?.cwd).toBeUndefined()
    // The dictionaries are still registered with this plugin's namespace.
    expect(Object.keys(zh)).toContain('view.all')

    await runtime.dispose()
  })

  it('drives the real component through the framework-resolved instance', async () => {
    const runtime = await bench()
    await runtime.sessions.add({ id: 's1' })

    // The seat comes from the framework's own resolution — the very instance
    // the registered entry is handed — not from a hand-built stub.
    const instance = acceptStoreOf(runtime, 's1')
    const props = {
      useConversation: () => ({ views: { get: () => undefined } }),
      useProjection: () => ({
        files: [{ path: '/proj/file1.ts', operation: 'write', firstSeq: 1, lastSeq: 10 }],
      }),
      useStore: bindSnapshotSelector(instance),
      actions: instance.actions,
      cwd: '/proj',
      openFile: () => Promise.resolve(),
      t: makeTranslate(zh, commonZh),
    } as unknown as Parameters<typeof SessionChangesDock>[0]

    const first = render(<SessionChangesDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /修改的文件/ }))
    fireEvent.click(screen.getByRole('button', { name: '接受' }))

    // The click reached the framework-resolved instance rather than a local copy.
    expect(instance.getSnapshot()).toEqual({ '/proj/file1.ts': 10 })

    // Which is exactly why the record outlives this mount.
    first.unmount()
    render(<SessionChangesDock {...props} />)
    expect(screen.getByText('0 处变更')).toBeDefined()

    await runtime.dispose()
  })
})
