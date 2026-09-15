// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArchivedSessionsSection } from '../src/client/ArchivedSessionsSection.tsx'
import type { ArchivedSessionsSectionProps } from '../src/client/ArchivedSessionsSection.tsx'
import { zh, type ArchivedSessionsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const DAY = 86_400_000
const sid = (id: string): SessionId => id as SessionId

// 直接用本地单语词典做翻译：页面读到的文案就是产品文案。
const t = ((key: ArchivedSessionsLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    zh[key],
  )) as ArchivedSessionsSectionProps['t']

function summary(id: string, title: string, updatedAt: number): SessionSummary {
  return { id: sid(id), displayTitle: title, running: false, blank: false, updatedAt }
}

function sessionState(
  sessions: readonly SessionSummary[],
  phase: SessionListState['phase'] = 'ready',
): SessionListState {
  return {
    ids: sessions.map(session => session.id),
    byId: Object.fromEntries(sessions.map(session => [session.id, session])),
    current: undefined,
    phase,
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function snapshot(
  archivedSessionIds: readonly string[],
  items: readonly WorkspaceView[] = [],
): WorkspaceSnapshot {
  return { items, archivedSessionIds: archivedSessionIds.map(sid), state: 'idle', phase: 'ready', error: null }
}

function workspace(title: string, sessionIds: readonly string[]): WorkspaceView {
  return {
    workspaceId: title as WorkspaceView['workspaceId'],
    path: `/work/${title}`,
    title,
    sessionIds: sessionIds.map(sid),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** 组装四个 props share 中的数据面：两个全局标准 prop 与注入的取消归档回调。 */
function props(options: {
  sessions: SessionListState
  workspaces: WorkspaceSnapshot
  unarchive?: (sessionId: SessionId) => Promise<void>
}): ArchivedSessionsSectionProps {
  return {
    t,
    unarchive: options.unarchive ?? (async () => {}),
    useSessions: ((select: (state: SessionListState) => unknown) => select(options.sessions)),
    useWorkspaces: ((select: (state: WorkspaceSnapshot) => unknown) => select(options.workspaces)),
  } as unknown as ArchivedSessionsSectionProps
}

/** 同一个 Workspace 下的两个已归档会话，按旧到新的归档顺序。 */
function twoRows(): ArchivedSessionsSectionProps {
  return props({
    sessions: sessionState([
      summary('older', '较早的会话', Date.now() - 2 * DAY),
      summary('newer', '较新的会话', Date.now()),
    ]),
    workspaces: snapshot(['older', 'newer'], [workspace('项目', ['older', 'newer'])]),
  })
}

describe('ArchivedSessionsSection', () => {
  it('按归档时间由新到旧列出行，并显示所属工作区与最近活动时间', () => {
    render(<ArchivedSessionsSection {...twoRows()} />)

    expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual([
      '较新的会话项目 · 刚刚取消归档',
      '较早的会话项目 · 2天取消归档',
    ])
    expect(screen.getAllByRole('button', { name: /^取消归档/ }).map(button => button.getAttribute('aria-label')))
      .toEqual(['取消归档 较新的会话', '取消归档 较早的会话'])
  })

  it('把工作区之外的会话标为未分组，并隐藏会话记录已不存在的条目', () => {
    render(<ArchivedSessionsSection {...props({
      sessions: sessionState([summary('loose', '散落的会话', Date.now())]),
      workspaces: snapshot(['gone', 'loose']),
    })} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('散落的会话')).toBeTruthy()
    expect(screen.getByText('未分组 · 刚刚')).toBeTruthy()
    // 没有已加载摘要的成员不产生行，也就不产生无法完成的取消归档操作。
    expect(screen.queryByRole('button', { name: '取消归档 gone' })).toBeNull()
  })

  it('会话列表到达前显示读取状态，到达后报告归档为空', () => {
    const pending = render(<ArchivedSessionsSection {...props({
      sessions: sessionState([], 'pending'),
      workspaces: snapshot([]),
    })} />)
    expect(screen.getByText(zh.loading)).toBeTruthy()
    expect(screen.queryByRole('searchbox')).toBeNull()
    pending.unmount()

    render(<ArchivedSessionsSection {...props({ sessions: sessionState([]), workspaces: snapshot([]) })} />)
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('归档集合非空但成员都没有摘要时报告无可恢复，而不是归档为空', () => {
    render(<ArchivedSessionsSection {...props({
      sessions: sessionState([]),
      workspaces: snapshot(['gone', 'vanished']),
    })} />)

    expect(screen.getByText(zh.unavailable)).toBeTruthy()
    expect(screen.queryByText(zh.empty)).toBeNull()
    expect(screen.queryByText(zh.emptySearch)).toBeNull()
  })

  it('按标题或工作区过滤，并对无匹配的查询报告空态', () => {
    render(<ArchivedSessionsSection {...twoRows()} />)
    const search = screen.getByRole('searchbox', { name: zh.search })

    fireEvent.change(search, { target: { value: '较早' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('较早的会话')).toBeTruthy()

    fireEvent.change(search, { target: { value: '项目' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.change(search, { target: { value: '不存在' } })
    expect(screen.getByText(zh.emptySearch)).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(screen.queryByText(zh.empty)).toBeNull()
  })

  it('取消归档被点击的行，并把拒绝留作 console 诊断', async () => {
    const unarchive = vi.fn(async () => {})
    render(<ArchivedSessionsSection {...twoRows()} unarchive={unarchive} />)
    fireEvent.click(screen.getByRole('button', { name: '取消归档 较新的会话' }))
    expect(unarchive).toHaveBeenCalledWith('newer')

    cleanup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('transport down')
    render(<ArchivedSessionsSection {...props({
      sessions: sessionState([summary('older', '较早的会话', Date.now())]),
      workspaces: snapshot(['older']),
      unarchive: async () => { throw failure },
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '取消归档 较早的会话' }))
    await waitFor(() => { expect(warn).toHaveBeenCalledWith('session unarchive rejected:', failure) })
    warn.mockRestore()
  })
})
