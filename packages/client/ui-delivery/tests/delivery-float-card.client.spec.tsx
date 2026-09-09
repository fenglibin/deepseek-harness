// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  DeliveryProjection,
  DeliverySnapshot,
  DeliveryTasksView,
} from '@deepseek-ai/dsh-delivery/client'
import { DeliveryFloatCard, type DeliveryFloatCardProps } from '../src/client/DeliveryFloatCard.tsx'
import { zh } from '../src/client/locales.ts'

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

function renderCard(value: DeliveryProjection | null | undefined, checklist?: DeliveryTasksView) {
  const props = {
    useProjection: (key: string) => {
      if (key === 'delivery') return value
      if (key === 'delivery-tasks') return checklist
      return undefined
    },
    t,
  } as DeliveryFloatCardProps
  return render(<DeliveryFloatCard {...props} />)
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
}

afterEach(cleanup)

describe('DeliveryFloatCard', () => {
  it('renders nothing while loading (undefined) or with no current task (null)', () => {
    const loading = renderCard(undefined)
    expect(loading.container.firstChild).toBeNull()
    cleanup()

    const absent = renderCard(null)
    expect(absent.container.firstChild).toBeNull()
  })

  it('shows the tier badge and objective', () => {
    renderCard(makeProjection())
    expect(screen.getByText('L2')).toBeDefined()
    expect(screen.getByText('Ship the delivery discipline')).toBeDefined()
  })

  it('renders the four semantic groups expanded by default for an l2 task', () => {
    renderCard(makeProjection(), CHECKLIST)
    expect(screen.getByTestId('delivery-float-progress')).toBeDefined()
    expect(screen.getByText('需求分析')).toBeDefined()
    expect(screen.getByText('设计文档')).toBeDefined()
    expect(screen.getByText('任务列表')).toBeDefined()
    expect(screen.getByText('实现验证')).toBeDefined()
  })

  it('omits the design group for an l0 task', () => {
    renderCard(makeProjection({ level: 'l0', designCount: 0 }))
    expect(screen.getByText('需求分析')).toBeDefined()
    expect(screen.queryByText('设计文档')).toBeNull()
  })

  it('shows 待拆分 when no checklist is recorded', () => {
    renderCard(makeProjection())
    expect(screen.getByText('待拆分')).toBeDefined()
  })

  it('renders checklist items with their status', () => {
    const { container } = renderCard(makeProjection(), CHECKLIST)
    const tasks = container.querySelector('[data-group="tasks"]')
    expect(tasks?.querySelector('[data-status="completed"]')).not.toBeNull()
    expect(tasks?.querySelector('[data-status="in_progress"]')).not.toBeNull()
    expect(tasks?.querySelector('[data-status="pending"]')).not.toBeNull()
    expect(screen.getByText('build it')).toBeDefined()
    expect(screen.getByText('test it')).toBeDefined()
    expect(screen.getByText('ship it')).toBeDefined()
  })

  it('shows analysis doing before mark_analysis_done and done after', () => {
    const doing = renderCard(makeProjection({ analysisDone: false }))
    expect(doing.container.querySelector('[data-group="analysis"]')?.getAttribute('data-state')).toBe('doing')
    cleanup()

    const done = renderCard(makeProjection({ analysisDone: true }))
    expect(done.container.querySelector('[data-group="analysis"]')?.getAttribute('data-state')).toBe('done')
  })

  it('shows the design group writing before a design record and done after', () => {
    const writing = renderCard(makeProjection({ designCount: 0 }))
    expect(writing.container.querySelector('[data-group="design"]')?.getAttribute('data-state')).toBe('writing')
    cleanup()

    const done = renderCard(makeProjection({ designCount: 1 }))
    expect(done.container.querySelector('[data-group="design"]')?.getAttribute('data-state')).toBe('done')
  })

  it('collapses on click and expands again', () => {
    renderCard(makeProjection())
    const button = screen.getByRole('button')
    fireEvent.click(button)
    expect(screen.queryByTestId('delivery-float-progress')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByTestId('delivery-float-progress')).toBeDefined()
  })
})
