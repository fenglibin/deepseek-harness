// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DeliveryProjection, DeliverySnapshot } from '@deepseek-ai/dsh-delivery/client'
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

function renderCard(value: DeliveryProjection | null | undefined) {
  const props = {
    useProjection: (key: string) => (key === 'delivery' ? value : undefined),
    t,
  } as DeliveryFloatCardProps
  return render(<DeliveryFloatCard {...props} />)
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
    renderCard(makeProjection())
    fireEvent.click(screen.getByRole('button'))
    const progress = screen.getByTestId('delivery-float-progress')
    expect(progress.querySelectorAll('[data-phase]')).toHaveLength(6)
    expect(progress.querySelector('[data-phase="specified"]')?.getAttribute('data-state')).toBe('current')
    expect(screen.getByText('.dsh/changes/task-1.md')).toBeDefined()
    expect(screen.getByText('.dsh/design/task-1.md')).toBeDefined()
    expect(screen.getByText('openspec/changes/task-1/spec.md')).toBeDefined()
  })

  it('collapses again on a second click', () => {
    renderCard(makeProjection())
    const button = screen.getByRole('button')
    fireEvent.click(button)
    expect(screen.getByTestId('delivery-float-progress')).toBeDefined()
    fireEvent.click(button)
    expect(screen.queryByTestId('delivery-float-progress')).toBeNull()
  })
})
