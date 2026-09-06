// @vitest-environment jsdom
/** Tool assembly acceptance through the real ui-conversation host. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TodoItem } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply as applyChat, inject as injectChat, type ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, TestRemote, usePinnedBrowserLanguages, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply as applyTool, inject as injectTool } from '../src/client/apply.ts'
import { toolSessionEvents } from './tool-details-render.client.tsx'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const SID = 's1' as SessionId

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})
const TODOS: TodoItem[] = [
  { content: '梳理需求', status: 'completed' },
  { content: '实现 fixture 样本', status: 'in_progress' },
  { content: '浏览器验收', status: 'pending' },
]

const todoResult = (seq: number): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId: `todo-${seq}`,
  call: { name: 'todo_write', argsRaw: JSON.stringify({ todos: TODOS }) },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, subCalls: [],
})

const bashResult = (seq: number, callId: string, over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name: 'bash', argsRaw: '{"command":"ls -la","description":"List files"}' },
  callTime: seq * 1_000 - 500,
  content: [{ type: 'text', text: 'total 2\ndemo.txt\n' }], isError: false,
  subCalls: [],
  ...over,
})

/** Test-owned AppFrame role: declares and renders the resident conversation area. */
type AppRootProps = PropsRenderSlots<'conversation' | 'details'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('conversation', {})}</>
}

const LAYOUT_CHILDREN = {
  'conversation': { kind: 'single', scope: 'session-maybe' },
  'details': { kind: 'single', scope: 'session' },
} as const

async function bench(nodes: ToolResultNode[]) {
  return benchEvents(toolSessionEvents(nodes))
}

/**
 * One `tool/call` with no result yet: the live running row a reader watches.
 * Both halves come from the shared fixture builder, so the pending prefix and
 * the result that settles it are exactly what a replayed session emits.
 * @returns the pending events and the result event that settles them.
 */
function pendingBashEvents(): {
  readonly pending: readonly SessionLiveEventEntry[]
  readonly result: SessionLiveEventEntry
} {
  return pendingCallEvents('c-live', 'bash')
}

/**
 * @param callId - the pending call's id.
 * @param name - wire tool name; one without a keyed row reaches the generic
 *   `ToolRow` path.
 * @returns the pending events and the result event that settles them.
 */
function pendingCallEvents(callId: string, name: string): {
  readonly pending: readonly SessionLiveEventEntry[]
  readonly result: SessionLiveEventEntry
} {
  // One node yields turn/start, step/start, tool/call, tool/result, in order.
  const events = toolSessionEvents([
    bashResult(4, callId, { call: { name, argsRaw: '{"command":"ls -la","description":"List files"}' } }),
  ])
  const result = events[3]
  if (result === undefined) throw new Error('the fixture builder emitted no result event')
  return { pending: events.slice(0, 3), result }
}

async function benchEvents(events: readonly SessionLiveEventEntry[]) {
  const runtime = await SlotTestRuntime.create()
  new TestRemote(runtime.ctx, {
    session: {
      openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })),
    },
  })
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  runtime.ctx.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  runtime.ctx.provide('uiWorkspace', {
    noteDraft: vi.fn(),
    connectWorkspace: vi.fn(async () => SID),
  } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
    events,
    session: {
      loadOlder: vi.fn<ISession['loadOlder']>(),
      prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
    },
  })
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  await runtime.mount({ inject: [...injectTool], apply: applyTool })
  return runtime
}

describe('todo_write assembly (product registrations, no outlet twins)', () => {
  it('reaches the keyed toolview row and the dock plan strip, and the strip follows projection retirement', async () => {
    const runtime = await bench([todoResult(3)])
    // The dock strip reads the host-computed 'todos' projection.
    runtime.sessions.behavior(SID).projections.set('todos', TODOS)
    const view = runtime.renderRoot()

    // Keyed toolview registration took the row (summary derived from args).
    const row = view.container.querySelector('[data-tool="todo_write"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('1/3 已完成 · 实现 fixture 样本')

    // The plan strip sits in the input dock, fed by the projection. It opens
    // expanded: an operational plan is what the user is working from, so its
    // rows are on screen without a click.
    const panel = view.container.querySelector('[data-testid="todo-panel"]')
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('1 已完成\u2002·\u20021 进行中\u2002·\u20021 待处理')
    expect([...panel!.querySelectorAll('li')].map(li => li.getAttribute('data-status')))
      .toEqual(['completed', 'in_progress', 'pending'])

    // Next turn retires the standing plan (host pushes null): the strip
    // clears while the historical row stays in the flow.
    await runtime.flush()
    runtime.sessions.behavior(SID).projections.set('todos', null)
    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="todo-panel"]')).toBeNull()
    })
    expect(view.container.querySelector('[data-tool="todo_write"]')).not.toBeNull()
    await runtime.dispose()
  })
})

describe('terminal card assembly', () => {
  it('both the keyed bash row and the fallback row reach the terminal card through the whole-row expand', async () => {
    const runtime = await bench([
      bashResult(3, 'c-keyed'),
      // pwsh has no package-local keyed row, so GenericToolCard owns its raw terminal card.
      bashResult(4, 'c-fallback', {
        call: { name: 'pwsh', argsRaw: '{"command":"ls -la","description":"List files"}' },
      }),
    ])
    const view = runtime.renderRoot()

    // Keyed BashRow: a settled row shows no terminal at all, and the whole
    // summary row is what opens it (capped to ten lines).
    const keyedRow = view.container.querySelector('[data-sample="bash"]')
    const keyed = keyedRow?.parentElement
    const keyedStage = () => keyed?.querySelector('[data-stage]')?.getAttribute('data-stage')
    expect(keyed!.querySelector('[data-terminal]')).toBeNull()
    expect(keyedStage()).toBeUndefined()
    fireEvent.click(keyedRow!)
    await waitFor(() => {
      expect(keyedStage()).toBe('full')
    })

    // Fallback row: same unified expand interaction.
    const fallback = view.container.querySelector('[data-tool="pwsh"]')
    expect(fallback).not.toBeNull()
    expect(fallback!.querySelector('[data-terminal]')).toBeNull()
    fireEvent.click(fallback!.querySelector('[data-expandable]')!)
    await waitFor(() => {
      expect(fallback!.querySelector('[data-terminal]')).not.toBeNull()
    })
    await runtime.dispose()
  })
})

describe('live bash row through the real event stream', () => {
  it('opens the running command and folds it when the result lands', async () => {
    const { pending, result } = pendingBashEvents()
    const runtime = await benchEvents(pending)
    const view = runtime.renderRoot()
    const row = () => view.container.querySelector('[data-sample="bash"]')
    const stage = () => view.container.querySelector('[data-stage]')?.getAttribute('data-stage')

    expect(row()).not.toBeNull()
    expect(row()!.getAttribute('data-state')).toBe('running')
    expect(row()!.getAttribute('aria-expanded')).toBe('true')
    expect(stage()).toBe('full')

    await runtime.sessions.appendEvent(SID, result)
    await runtime.flush()

    expect(row()!.getAttribute('data-state')).toBe('ok')
    expect(row()!.getAttribute('aria-expanded')).toBe('false')
    // Settlement takes the output box away, not just down to two lines: a
    // settled transcript is a list of one-line summaries.
    expect(stage()).toBeUndefined()
    expect(view.container.querySelector('[data-terminal]')).toBeNull()
    expect(view.container.textContent).not.toContain('total 2')
    await runtime.dispose()
  })

  it('folds a generic row shut: its output box leaves the DOM entirely', async () => {
    // The contrast the bash row's preview exists against. `pwsh` has no keyed
    // row, so GenericToolCard owns it: its args body makes the row expandable
    // while running, and a generic row has no collapsed preview — settlement
    // removes the output box outright instead of shrinking it to two lines.
    const { pending, result } = pendingCallEvents('c-generic', 'pwsh')
    const runtime = await benchEvents(pending)
    const view = runtime.renderRoot()
    const row = () => view.container.querySelector('[data-tool="pwsh"]')
    const expanded = () => row()?.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')

    expect(row()!.getAttribute('data-state')).toBe('running')
    expect(expanded()).toBe('true')

    await runtime.sessions.appendEvent(SID, result)
    await runtime.flush()

    expect(row()!.getAttribute('data-state')).toBe('ok')
    expect(expanded()).toBe('false')
    expect(view.container.textContent).not.toContain('total 2')
    await runtime.dispose()
  })
})
