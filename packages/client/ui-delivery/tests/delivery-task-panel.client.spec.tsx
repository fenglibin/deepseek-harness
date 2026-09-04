// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { DeliveryTaskPanel, type DeliveryTaskPanelProps } from '../src/client/DeliveryTaskPanel.tsx'
import { zh } from '../src/client/locales.ts'
import type { DeliveryTaskChatData } from '../src/client/delivery-definition.ts'

const t: DeliveryTaskPanelProps['t'] = makeTranslate(zh, commonZh)

function makeData(over: Partial<DeliveryTaskChatData> = {}): DeliveryTaskChatData {
  return {
    objective: 'Ship the delivery discipline',
    level: 'l2',
    phase: 'specified',
    changeCount: 1,
    designCount: 1,
    specCount: 1,
    cleared: false,
    events: [
      { seq: 3, time: 300, operation: 'create', phase: 'created' },
      { seq: 4, time: 400, operation: 'record-design', text: 'design one' },
      { seq: 5, time: 500, operation: 'advance', phase: 'designed' },
      { seq: 6, time: 600, operation: 'record-spec', text: 'spec one' },
      { seq: 7, time: 700, operation: 'advance', phase: 'specified' },
    ],
    ...over,
  }
}

function makeNode(data: DeliveryTaskChatData): ChatConversationViewNode {
  return {
    key: 'delivery-task:task-1',
    kind: 'delivery-task',
    id: 'task-1',
    target: 'chat',
    anchorSeq: 3,
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data,
  }
}

function renderPanel(data: DeliveryTaskChatData) {
  const props = {
    node: makeNode(data) as DeliveryTaskPanelProps['node'],
    t,
  } as DeliveryTaskPanelProps
  return render(<DeliveryTaskPanel {...props} />)
}

afterEach(cleanup)

describe('DeliveryTaskPanel', () => {
  it('shows the objective, level badge, and phase progress bar', () => {
    renderPanel(makeData())
    expect(screen.getByText('Ship the delivery discipline')).toBeDefined()
    expect(screen.getByText('L2')).toBeDefined()

    const progress = screen.getByTestId('delivery-task-progress')
    expect(progress.querySelectorAll('[data-phase]')).toHaveLength(6)
    expect(progress.querySelector('[data-phase="created"]')?.getAttribute('data-state')).toBe('done')
    expect(progress.querySelector('[data-phase="designed"]')?.getAttribute('data-state')).toBe('done')
    expect(progress.querySelector('[data-phase="specified"]')?.getAttribute('data-state')).toBe('current')
    expect(progress.querySelector('[data-phase="implemented"]')?.getAttribute('data-state')).toBe('todo')
  })

  it('lists every mutation in the timeline in order', () => {
    renderPanel(makeData())
    const events = document.querySelectorAll('[data-operation]')
    expect(events.length).toBe(5)
    const labels = [...events].map(element => element.querySelector('[class*="eventLabel"]')?.textContent)
    expect(labels).toEqual(['创建任务', '记录设计', '推进到 已设计', '记录拆分', '推进到 已拆分'])
  })

  it('defaults an accepted task to collapsed', () => {
    renderPanel(makeData({ phase: 'accepted' }))
    expect(screen.queryByTestId('delivery-task-progress')).toBeNull()
  })

  it('defaults a cleared task to collapsed and shows its cleared state', () => {
    const data = makeData({ cleared: true, events: [
      { seq: 3, time: 300, operation: 'create', phase: 'created' },
      { seq: 4, time: 400, operation: 'clear' },
    ] })
    renderPanel(data)
    expect(screen.queryByTestId('delivery-task-progress')).toBeNull()
    expect(document.querySelector('[data-cleared]')).toBeDefined()
  })

  it('re-settles the card when a live task reaches accepted', () => {
    const first = renderPanel(makeData({ phase: 'specified' }))
    expect(screen.getByTestId('delivery-task-progress')).toBeDefined()
    first.rerender(
      <DeliveryTaskPanel
        {...({
          node: makeNode(makeData({ phase: 'accepted' })) as DeliveryTaskPanelProps['node'],
          t,
        } as DeliveryTaskPanelProps)}
      />,
    )
    expect(screen.queryByTestId('delivery-task-progress')).toBeNull()
  })

  it('re-settles the card when a live task is cleared', () => {
    const first = renderPanel(makeData({ phase: 'specified' }))
    expect(screen.getByTestId('delivery-task-progress')).toBeDefined()
    first.rerender(
      <DeliveryTaskPanel
        {...({
          node: makeNode(makeData({ phase: 'specified', cleared: true })) as DeliveryTaskPanelProps['node'],
          t,
        } as DeliveryTaskPanelProps)}
      />,
    )
    expect(screen.queryByTestId('delivery-task-progress')).toBeNull()
    expect(document.querySelector('[data-cleared]')).toBeDefined()
  })
})
