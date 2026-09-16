// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  DeliveryProjection,
  DeliverySnapshot,
  DeliveryTasksView,
} from '@deepseek-ai/dsh-delivery/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import {
  DeliveryFloatCard, type DeliveryFloatCardProps,
} from '../src/client/DeliveryFloatCard.tsx'
import { zh } from '../src/client/locales.ts'
import { createDeliveryCardStore, DELIVERY_CARD_PERSIST_KEY, type DeliveryCardPreference } from '../src/client/visibility-store.ts'

const t: DeliveryFloatCardProps['t'] = makeTranslate(zh, commonZh)

function makeSnapshot(over: Partial<DeliverySnapshot> = {}): DeliverySnapshot {
  return {
    id: 'task-1' as DeliverySnapshot['id'],
    revision: 1,
    objective: 'Ship the delivery discipline',
    phase: 'specified',
    level: 'l2',
    changeCount: 1,
    designCount: 1,
    specCount: 1,
    analysisDone: false,
    ...over,
  }
}

function makeProjection(over: Partial<DeliverySnapshot> = {}): DeliveryProjection {
  return { task: makeSnapshot(over), createdAt: 1, updatedAt: 1 }
}

/** A checklist with one item in each of the three statuses. */
const CHECKLIST: DeliveryTasksView = {
  changeId: 'add-thing',
  items: [
    { content: 'build it', phase: 'implemented', status: 'completed' },
    { content: 'test it', phase: 'verified', status: 'in_progress' },
    { content: 'ship it', phase: 'verified', status: 'pending' },
  ],
  progress: {
    created: { done: 0, total: 0 },
    designed: { done: 0, total: 0 },
    specified: { done: 0, total: 0 },
    implemented: { done: 1, total: 1 },
    verified: { done: 0, total: 2 },
    accepted: { done: 0, total: 0 },
  },
  source: 'recorded',
}

const TODOS: readonly TodoItem[] = [
  { content: 'do the thing', status: 'in_progress' },
  { content: 'check the thing', status: 'pending' },
]

interface MountOptions {
  checklist?: DeliveryTasksView | undefined
  todos?: readonly TodoItem[] | undefined
  openFile?: (path: string) => Promise<void>
  /** Preference to seed before the first render. */
  preference?: DeliveryCardPreference
}

function renderCard(value: DeliveryProjection | null | undefined, over: MountOptions = {}) {
  // Real store instance — the sanctioned zero-machinery path for tests. The
  // preference is written through store.set rather than an action because a
  // persisted value from an earlier mount in the same test would otherwise
  // change what an action lands on.
  const handle = createDeliveryCardStore()
  const instance = handle.create()
  if (over.preference !== undefined) instance.store.set({ preference: over.preference })
  const openFile = over.openFile ?? vi.fn<(path: string) => Promise<void>>(() => Promise.resolve())
  const props = {
    useProjection: (key: string) => {
      if (key === 'delivery') return value
      if (key === 'delivery-tasks') return over.checklist
      if (key === 'todos') return over.todos
      return undefined
    },
    useStore: bindSnapshotSelector(instance.store),
    actions: instance.actions,
    openFile,
    t,
  } as unknown as DeliveryFloatCardProps
  const view = render(<DeliveryFloatCard {...props} />)
  return { ...view, store: instance.store, actions: instance.actions, openFile }
}

/** Mount with the card already shown, the pre-toggle state the layout tests assume. */
function renderVisible(value: DeliveryProjection | null | undefined, over: MountOptions = {}) {
  return renderCard(value, { ...over, preference: 'shown' })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('DeliveryFloatCard visibility', () => {
  it('shows the card by default while a task is current', () => {
    const { container } = renderCard(makeProjection())
    // The card follows the task by default, so progress is visible without the
    // reader discovering a shortcut.
    expect(container.querySelector('[data-delivery-float]')).not.toBeNull()
  })

  it('ignores other key combinations', () => {
    const { store } = renderCard(makeProjection())
    fireEvent.keyDown(document, { key: 'p' })
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true })
    fireEvent.keyDown(document, { key: 'p', shiftKey: true })
    fireEvent.keyDown(document, { key: 'o', ctrlKey: true, shiftKey: true })
    expect(store.getSnapshot()).toEqual({ preference: 'auto' })
  })

  it('Ctrl+Shift+P cycles the preference through shown, hidden, and auto', () => {
    const { container, store } = renderCard(makeProjection())
    fireEvent.keyDown(document, { key: 'P', ctrlKey: true, shiftKey: true })
    expect(store.getSnapshot()).toEqual({ preference: 'shown' })
    expect(container.querySelector('[data-delivery-float]')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true })
    expect(store.getSnapshot()).toEqual({ preference: 'hidden' })
    expect(container.firstChild).toBeNull()
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true })
    expect(store.getSnapshot()).toEqual({ preference: 'auto' })
    expect(container.querySelector('[data-delivery-float]')).not.toBeNull()
  })

  it('persists the choice under the declared key', async () => {
    const { store } = renderCard(makeProjection())
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true })
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(DELIVERY_CARD_PERSIST_KEY) ?? 'null')).toEqual({ preference: 'shown' })
    })
    expect(store.getSnapshot()).toEqual({ preference: 'shown' })
  })

  it('stops listening once the card unmounts', () => {
    const { unmount, store } = renderCard(makeProjection())
    unmount()
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true })
    expect(store.getSnapshot()).toEqual({ preference: 'auto' })
  })
})

describe('DeliveryFloatCard', () => {
  it('renders nothing while loading (undefined) or with no current task (null)', () => {
    const loading = renderVisible(undefined)
    expect(loading.container.firstChild).toBeNull()
    cleanup()

    const absent = renderVisible(null)
    expect(absent.container.firstChild).toBeNull()
  })

  it('shows the tier badge and objective', () => {
    renderVisible(makeProjection())
    expect(screen.getByText('L2')).toBeDefined()
    expect(screen.getByText('Ship the delivery discipline')).toBeDefined()
  })

  it('renders the four semantic groups expanded by default for an l2 task', () => {
    renderVisible(makeProjection(), { checklist: CHECKLIST })
    expect(screen.getByTestId('delivery-float-progress')).toBeDefined()
    expect(screen.getByText('需求分析')).toBeDefined()
    expect(screen.getByText('设计文档')).toBeDefined()
    expect(screen.getByText('任务列表')).toBeDefined()
    expect(screen.getByText('实现验证')).toBeDefined()
  })

  it('omits the design group for an l0 task', () => {
    renderVisible(makeProjection({ level: 'l0', designCount: 0 }))
    expect(screen.getByText('需求分析')).toBeDefined()
    expect(screen.queryByText('设计文档')).toBeNull()
  })

  it('shows 待拆分 when neither a checklist nor todos exist', () => {
    renderVisible(makeProjection())
    expect(screen.getByText('待拆分')).toBeDefined()
  })

  it('renders checklist items with their status', () => {
    const { container } = renderVisible(makeProjection(), { checklist: CHECKLIST })
    const tasks = container.querySelector('[data-group="tasks"]')
    expect(tasks?.querySelector('[data-status="completed"]')).not.toBeNull()
    expect(tasks?.querySelector('[data-status="in_progress"]')).not.toBeNull()
    expect(tasks?.querySelector('[data-status="pending"]')).not.toBeNull()
    expect(screen.getByText('build it')).toBeDefined()
    expect(screen.getByText('test it')).toBeDefined()
    expect(screen.getByText('ship it')).toBeDefined()
  })

  it('shows analysis doing before mark_analysis_done and done after', () => {
    const doing = renderVisible(makeProjection({ analysisDone: false }))
    expect(doing.container.querySelector('[data-group="analysis"]')?.getAttribute('data-state')).toBe('doing')
    cleanup()

    const done = renderVisible(makeProjection({ analysisDone: true }))
    expect(done.container.querySelector('[data-group="analysis"]')?.getAttribute('data-state')).toBe('done')
  })

  it('shows the design group writing before a design record and done after', () => {
    const writing = renderVisible(makeProjection({ designCount: 0 }))
    expect(writing.container.querySelector('[data-group="design"]')?.getAttribute('data-state')).toBe('writing')
    cleanup()

    const done = renderVisible(makeProjection({ designCount: 1 }))
    expect(done.container.querySelector('[data-group="design"]')?.getAttribute('data-state')).toBe('done')
  })

  it('collapses on click and expands again', () => {
    renderVisible(makeProjection())
    // The header row is the card's own toggle; the design link is the other
    // button in the panel, so the query names the objective rather than
    // taking the only button.
    const button = screen.getByRole('button', { name: /Ship the delivery discipline/ })
    fireEvent.click(button)
    expect(screen.queryByTestId('delivery-float-progress')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByTestId('delivery-float-progress')).toBeDefined()
  })
})

describe('DeliveryFloatCard design document link', () => {
  it('offers the design document as an openable link once a design is recorded', () => {
    renderVisible(makeProjection({ designCount: 1 }))
    expect(screen.getByRole('button', { name: '打开 .dsh/design/task-1.md' })).toBeDefined()
  })

  it('omits the link while the design is still being written', () => {
    renderVisible(makeProjection({ designCount: 0 }))
    expect(screen.queryByRole('button', { name: /\.dsh\/design/ })).toBeNull()
  })

  it('hands the artifact path to the Host opener', () => {
    const openFile = vi.fn<(path: string) => Promise<void>>(() => Promise.resolve())
    renderVisible(makeProjection({ designCount: 1 }), { openFile })
    fireEvent.click(screen.getByRole('button', { name: '打开 .dsh/design/task-1.md' }))
    expect(openFile).toHaveBeenCalledWith('.dsh/design/task-1.md')
  })

  it('reports a refused open in place', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('xdg-open is not available'))
    renderVisible(makeProjection({ designCount: 1 }), { openFile })
    fireEvent.click(screen.getByRole('button', { name: '打开 .dsh/design/task-1.md' }))
    await screen.findByText('打开失败：xdg-open is not available')
  })
})

describe('DeliveryFloatCard todo fallback', () => {
  it('reads the checklist from the delivery-tasks projection, not the todo projection', () => {
    // `delivery-tasks` is the single authority: the host fold mirrors an l1
    // todo list into it, so the card never falls back to the todo projection.
    // A todo list with no mirrored checklist therefore renders nothing here.
    const { container } = renderVisible(makeProjection(), { todos: TODOS })
    const tasks = container.querySelector('[data-group="tasks"]')
    expect(tasks?.querySelectorAll('[data-source="todo"]')).toHaveLength(0)
    expect(screen.queryByText('do the thing')).toBeNull()
    expect(screen.getByText('待拆分')).toBeDefined()
  })

  it('shows a mirrored checklist with its source marker', () => {
    const mirrored = {
      changeId: '',
      items: [
        { content: 'do the thing', phase: 'implemented' as const, status: 'pending' as const },
        { content: 'check the thing', phase: 'implemented' as const, status: 'completed' as const },
      ],
      progress: {
        created: { done: 0, total: 0 },
        designed: { done: 0, total: 0 },
        specified: { done: 0, total: 0 },
        implemented: { done: 1, total: 2 },
        verified: { done: 0, total: 0 },
        accepted: { done: 0, total: 0 },
      },
      source: 'mirrored' as const,
    }
    const { container } = renderVisible(makeProjection(), { checklist: mirrored })
    const tasks = container.querySelector('[data-group="tasks"]')
    expect(tasks?.querySelectorAll('[data-phase="implemented"]')).toHaveLength(1)
    expect(screen.getByText('do the thing')).toBeDefined()
    expect(screen.getByText('来自当轮清单')).toBeDefined()
  })

  it('groups the checklist by phase with per-phase counts', () => {
    const { container } = renderVisible(makeProjection(), { checklist: CHECKLIST })
    const tasks = container.querySelector('[data-group="tasks"]')
    // CHECKLIST carries one implemented item and two verified items, so both
    // stages render and an empty stage does not.
    expect(tasks?.querySelectorAll('[data-phase="verified"]')).toHaveLength(1)
    expect(tasks?.querySelectorAll('[data-phase="implemented"]')).toHaveLength(1)
    expect(tasks?.querySelectorAll('[data-phase="designed"]')).toHaveLength(0)
    expect(screen.getByText('1/1 已完成')).toBeDefined()
    expect(screen.getByText('0/2 已完成')).toBeDefined()
    expect(screen.getByText('来自任务清单')).toBeDefined()
  })

  it('keeps the delivery checklist authoritative when both exist', () => {
    const { container } = renderVisible(makeProjection(), { checklist: CHECKLIST, todos: TODOS })
    const tasks = container.querySelector('[data-group="tasks"]')
    expect(tasks?.querySelectorAll('[data-source="todo"]')).toHaveLength(0)
    expect(screen.queryByText('do the thing')).toBeNull()
    expect(screen.getByText('build it')).toBeDefined()
  })
})
