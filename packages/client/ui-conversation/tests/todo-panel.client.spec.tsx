// @vitest-environment jsdom
/**
 * Todo display acceptance: the TodoPanel plan strip (empty-hidden, status rows
 * including several `in_progress` at once, collapse), the authoritativeTodos
 * selection between the delivery checklist and the turn's todo list, and its
 * TodoDock adapter (selects off the session snapshot and follows changes).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { DeliveryProjection, DeliveryTasksView } from '@deepseek-ai/dsh-delivery/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { TodoDockProps } from '../src/client/skeleton/TodoPanel.tsx'
import { TodoDock, TodoPanel, authoritativeTodos, todoDockEntry } from '../src/client/skeleton/TodoPanel.tsx'
import { NS, zh } from '../src/client/locales.ts'

const t: TodoDockProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

const LIST: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

/** A parallel plan: three tasks running at once (concurrent subagents). */
const PARALLEL: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '跑后台构建', status: 'in_progress' },
  { content: '读源码', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

describe('TodoPanel', () => {
  it('renders nothing while the list is empty', () => {
    const { container } = render(<TodoPanel todos={[]} t={t} />)
    expect(container.innerHTML).toBe('')
  })

  it('starts collapsed with the per-status count summary and no rows', () => {
    render(<TodoPanel todos={LIST} t={t} />)
    expect(screen.getByTestId('todo-panel')).toBeTruthy()
    expect(screen.getByText('任务')).toBeTruthy()
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    // The strip sits directly above the composer, so the standing reading is
    // the header's count summary; the item list costs one click.
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText('写组件')).toBeNull()
  })

  it('omits the completed segment while nothing is done yet', () => {
    render(<TodoPanel todos={[
      { content: '写组件', status: 'in_progress' },
      { content: '补测试', status: 'pending' },
    ]} t={t} />)
    expect(screen.getByText('1 进行中 · 1 待处理')).toBeTruthy()
    expect(screen.queryByText(/已完成/)).toBeNull()
  })

  it('expands to show one row per item with its status glyph', () => {
    render(<TodoPanel todos={LIST} t={t} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const items = screen.getAllByRole('listitem')
    expect(items.map(li => li.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(screen.getByText('搭骨架')).toBeTruthy()
    expect(screen.getByText('写组件')).toBeTruthy()
    // Each status row carries an SVG glyph (not a text bullet).
    expect(items.every(li => li.querySelector('svg') !== null)).toBe(true)
  })

  it('expand reveals the list; collapse restores; header keeps the count summary either way', () => {
    render(<TodoPanel todos={LIST} t={t} />)
    const collapsedHeader = screen.getByRole('button', { expanded: false })
    // Collapsed header is title + progress only (no in-progress content hint).
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
    expect(screen.queryByText('写组件')).toBeNull()
    fireEvent.click(collapsedHeader)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
  })

  it('marks every parallel active item, and counts them all in the header', () => {
    render(<TodoPanel todos={PARALLEL} t={t} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    // An unconditional in-progress cap would make this list unreachable: three
    // items carry the in-progress glyph at once, and the header counts all three.
    const statuses = screen.getAllByRole('listitem').map(li => li.getAttribute('data-status'))
    expect(statuses.filter(s => s === 'in_progress')).toHaveLength(3)
    expect(screen.getByText('跑后台构建')).toBeTruthy()
    expect(screen.getByText('读源码')).toBeTruthy()
    expect(screen.getByText('1 已完成 · 3 进行中 · 1 待处理')).toBeTruthy()
  })

  it('an all-completed list collapses the summary to the done count alone', () => {
    render(<TodoPanel todos={[{ content: '都完了', status: 'completed' }]} t={t} />)
    // Defaults to collapsed: the summary alone carries the lone item's status.
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    expect(screen.getByText('1 已完成')).toBeTruthy()
    expect(screen.queryByText(/进行中|待处理/)).toBeNull()
    // The single item is behind the toggle, not in the strip.
    expect(screen.queryByText('都完了')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('都完了')).toBeTruthy()
  })
})

/** One session's three projections: the plan, the task, and the task's checklist. */
interface DockState {
  todos: readonly TodoItem[] | null | undefined
  task?: DeliveryProjection | null
  checklist?: DeliveryTasksView | null
}

/** Dock props stub: the adapter reads only the three projections; the rest of the owner share is unused. */
function dockProps(store: ReturnType<typeof createSnapshotStore<DockState>>): TodoDockProps {
  const useProjection = (key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(
      key === 'todos' ? s.todos : key === 'delivery' ? s.task : s.checklist,
    ))
  return { useProjection, t } as unknown as TodoDockProps
}

/** A current delivery task as the host serves it; only its presence reaches the selector. */
const TASK = { task: { id: 'task-1' } } as unknown as DeliveryProjection

/** A recorded delivery checklist as the host serves it, with per-phase progress. */
function checklistOf(items: DeliveryTasksView['items']): DeliveryTasksView {
  const count = (phase: DeliveryTasksView['items'][number]['phase']) => {
    const phaseItems = items.filter(item => item.phase === phase)
    return { done: phaseItems.filter(item => item.status === 'completed').length, total: phaseItems.length }
  }
  return {
    changeId: '',
    items,
    progress: {
      created: count('created'),
      designed: count('designed'),
      specified: count('specified'),
      implemented: count('implemented'),
      verified: count('verified'),
      accepted: count('accepted'),
    },
    source: 'recorded',
  }
}

describe('TodoDock', () => {
  it('reads the host-computed todos projection and follows pushed updates', () => {
    const store = createSnapshotStore<DockState>({ todos: undefined })
    render(<TodoDock {...dockProps(store)} />)
    // Capability absent (no baseline/frame yet) renders nothing.
    expect(screen.queryByTestId('todo-panel')).toBeNull()
    act(() => { store.set({ todos: LIST }) })
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
    // The pre-first-write whole value (null) retires the strip (the panel owns no data).
    act(() => { store.set({ todos: null }) })
    expect(screen.queryByTestId('todo-panel')).toBeNull()
  })

  it('shows the delivery checklist instead of the todo list once a task exists', () => {
    // The two surfaces must never disagree: the left-hand delivery card reads
    // this same projection, and the model writes the todo list first, so
    // rendering `todos` here showed the staler plan.
    const store = createSnapshotStore<DockState>({ todos: LIST, task: TASK, checklist: null })
    render(<TodoDock {...dockProps(store)} />)
    // The task exists but recorded no checklist yet, so neither surface has a plan.
    expect(screen.queryByTestId('todo-panel')).toBeNull()
    act(() => {
      store.set({
        todos: LIST,
        task: TASK,
        checklist: checklistOf([
          { content: '交付条目甲', phase: 'implemented', status: 'completed' },
          { content: '交付条目乙', phase: 'implemented', status: 'completed' },
        ]),
      })
    })
    // The header counts follow the same list, so the two cannot disagree, and
    // the collapsed strip already proves WHICH list won without opening it.
    expect(screen.getByText('2 已完成')).toBeTruthy()
    expect(screen.queryByText('写组件')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('交付条目甲')).toBeTruthy()
    expect(screen.getByText('交付条目乙')).toBeTruthy()
    expect(screen.queryByText('写组件')).toBeNull()
  })

  it('keeps rendering todos for a session with no delivery task', () => {
    // A plain conversation, and any deployment without the delivery domain.
    const store = createSnapshotStore<DockState>({ todos: LIST, task: null })
    render(<TodoDock {...dockProps(store)} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('写组件')).toBeTruthy()
  })

  it('renders no plan for an l0 task, whose todo list never mirrors a checklist', () => {
    // `todo_write` does not mirror at l0, so the checklist stays empty while
    // `todos` is populated. Keying the source on a non-empty checklist showed
    // the turn plan here while the delivery card showed 待拆分.
    const store = createSnapshotStore<DockState>({ todos: LIST, task: TASK, checklist: checklistOf([]) })
    render(<TodoDock {...dockProps(store)} />)
    expect(screen.queryByTestId('todo-panel')).toBeNull()
  })

  it('registers before the goal and queue entries', () => {
    expect(todoDockEntry.name).toBe('conversation-todo-dock')
    expect(todoDockEntry.inject).toEqual(['slots'])
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    todoDockEntry.apply({ slots: { inject, register } } as never)
    expect(inject).toHaveBeenCalledWith('conversation.input.dock', expect.any(Function))
    expect(register).toHaveBeenCalledWith({ name: 'conversation.input.dock', id: 'todo', order: 0, locale: NS }, TodoDock)
  })
})

describe('authoritativeTodos', () => {
  const checklist = checklistOf([{ content: '甲', phase: 'implemented', status: 'completed' }])

  it('takes the plan from the checklist whenever the session holds a task', () => {
    const list = authoritativeTodos(true, checklist, LIST)
    expect(list.map(item => item.content)).toEqual(['甲'])
    expect(list[0]?.status).toBe('completed')
  })

  it('has no plan for a task whose checklist is absent or empty', () => {
    // An l0 task never mirrors and an l2 task cannot call todo_write, so an
    // empty checklist is a legitimate answer rather than a reason to fall back:
    // the delivery card shows 待拆分 in exactly this state.
    expect(authoritativeTodos(true, checklistOf([]), LIST)).toHaveLength(0)
    expect(authoritativeTodos(true, null, LIST)).toHaveLength(0)
    expect(authoritativeTodos(true, undefined, LIST)).toHaveLength(0)
  })

  it('falls back to the todo list for a session with no delivery task', () => {
    expect(authoritativeTodos(false, null, LIST)).toBe(LIST)
    expect(authoritativeTodos(false, checklist, LIST)).toBe(LIST)
  })

  it('returns a stable empty list when there is no plan to show', () => {
    const first = authoritativeTodos(false, null, null)
    expect(first).toHaveLength(0)
    // A fresh array per render would defeat the snapshot identity contract.
    expect(authoritativeTodos(false, undefined, null)).toBe(first)
    expect(authoritativeTodos(true, null, LIST)).toBe(first)
    expect(authoritativeTodos(true, checklistOf([]), LIST)).toBe(first)
  })
})
