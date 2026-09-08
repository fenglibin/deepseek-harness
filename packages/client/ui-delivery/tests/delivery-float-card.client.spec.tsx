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

/** A checklist whose only item sits in the implemented phase. */
const CHECKLIST: DeliveryTasksView = {
  changeId: 'add-thing',
  items: [{ content: 'build it', phase: 'implemented', done: true }],
  progress: {
    created: { done: 0, total: 0 },
    designed: { done: 0, total: 0 },
    specified: { done: 0, total: 0 },
    implemented: { done: 1, total: 2 },
    verified: { done: 0, total: 0 },
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

  it('shows the tier badge, phase, and objective in the compact card', () => {
    renderCard(makeProjection())
    expect(screen.getByText('L2')).toBeDefined()
    expect(screen.getByText('已拆分')).toBeDefined()
    expect(screen.getByText('Ship the delivery discipline')).toBeDefined()
    expect(screen.queryByTestId('delivery-float-progress')).toBeNull()
  })

  it('expands to reveal the phase progress bar and artifact paths', () => {
    renderCard(makeProjection(), CHECKLIST)
    fireEvent.click(screen.getByRole('button'))
    const progress = screen.getByTestId('delivery-float-progress')
    expect(progress.querySelectorAll('[data-phase]')).toHaveLength(6)
    expect(progress.querySelector('[data-phase="specified"]')?.getAttribute('data-state')).toBe('current')
    expect(screen.getByText('.dsh/changes/task-1.md')).toBeDefined()
    expect(screen.getByText('.dsh/design/task-1.md')).toBeDefined()
    expect(screen.getByText('openspec/changes/add-thing/')).toBeDefined()
  })

  it('omits the OpenSpec path until a checklist names the change', () => {
    renderCard(makeProjection())
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText(/^openspec\/changes\//)).toBeNull()
  })

  it('collapses again on a second click', () => {
    renderCard(makeProjection())
    const button = screen.getByRole('button')
    fireEvent.click(button)
    expect(screen.getByTestId('delivery-float-progress')).toBeDefined()
    fireEvent.click(button)
    expect(screen.queryByTestId('delivery-float-progress')).toBeNull()
  })

  it('shows checklist counts beside the phases that carry items', () => {
    renderCard(makeProjection(), CHECKLIST)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('delivery-float-counts-implemented').textContent).toBe('1/2 已完成')
    expect(screen.queryByTestId('delivery-float-counts-created')).toBeNull()
  })

  it('omits checklist counts when no checklist is recorded', () => {
    renderCard(makeProjection())
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByTestId('delivery-float-counts-implemented')).toBeNull()
  })

  it('expands itself when the task reaches a new phase', () => {
    const props = (phase: DeliverySnapshot['phase']) => ({
      useProjection: (key: string) => (key === 'delivery' ? makeProjection({ phase }) : undefined),
      t,
    } as DeliveryFloatCardProps)
    const view = render(<DeliveryFloatCard {...props('created')} />)
    expect(screen.queryByTestId('delivery-float-progress')).toBeNull()
    view.rerender(<DeliveryFloatCard {...props('designed')} />)
    expect(screen.getByTestId('delivery-float-progress')).toBeDefined()
  })
})
