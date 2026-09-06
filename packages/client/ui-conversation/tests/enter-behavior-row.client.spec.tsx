// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EnterBehaviorRow } from '../src/client/settings/EnterBehaviorRow.tsx'
import type { EnterBehaviorRowProps } from '../src/client/settings/EnterBehaviorRow.tsx'
import { ComposerSubmissionPolicy } from '../src/client/input/submission-policy.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}

function noPendingInteraction() {
  return bindSnapshotSelector(createSnapshotStore<SessionPendingInteractionSnapshot>(new Map()))
}

function mount() {
  const policy = new ComposerSubmissionPolicy()
  const setBusyEnter = vi.fn((behavior: 'queue' | 'steer') => { policy.setBusyEnter(behavior) })
  const props: EnterBehaviorRowProps = {
    useSessions: emptySessions(),
    useSessionPendingInteraction: noPendingInteraction(),
    useWorkspaces: emptyWorkspaces(),
    useBusyEnter: bindSnapshotSelector(policy.busyEnter),
    setBusyEnter,
    t: makeTranslate(zh),
  }
  render(<EnterBehaviorRow {...props} />)
  return { policy, setBusyEnter }
}

describe('EnterBehaviorRow', () => {
  it('explains the busy-only scope and shows Queue by default', () => {
    mount()
    expect(screen.getByText('繁忙时 Enter 键行为')).toBeDefined()
    expect(screen.getByText('仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为')).toBeDefined()
    expect(screen.getByRole('button', { name: '排队发送' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('selects Steer, follows later preference changes, and closes outside', () => {
    const b = mount()
    const trigger = screen.getByRole('button', { name: '排队发送' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: '插话发送' }))
    expect(b.setBusyEnter).toHaveBeenCalledWith('steer')
    expect(screen.getByRole('button', { name: '插话发送' })).toBeDefined()

    act(() => { b.policy.setBusyEnter('queue') })
    const queueTrigger = screen.getByRole('button', { name: '排队发送' })
    fireEvent.click(queueTrigger)
    expect(screen.getByRole('menuitem', { name: '插话发送' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: '插话发送' })).toBeNull()
  })
})
