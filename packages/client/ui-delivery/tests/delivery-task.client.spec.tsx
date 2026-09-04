// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  ConversationNodeAssembler, type ConversationNodeDefinition, type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  deliveryTaskDefinition, type DeliveryTaskChatData,
} from '../src/client/delivery-definition.ts'

interface ChatSnapshot {
  readonly nodes: ReadonlyMap<string, ChatConversationViewNode>
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [deliveryTaskDefinition] }
  fallbackEntry(): undefined { return undefined }
}

const chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => {
    let nodes = new Map<string, ChatConversationViewNode>()
    const snapshot = (): ChatSnapshot => ({ nodes })
    return {
      empty: snapshot(),
      replace: ({ nodes: values }) => {
        nodes = new Map(values.map(node => [node.key, node]))
        return snapshot()
      },
      apply: ({ upserts }) => {
        nodes = new Map(nodes)
        for (const node of upserts) nodes.set(node.key, node)
        return snapshot()
      },
    }
  },
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [chatViewDefinition] }
}

function at(seq: number, type: string, data: unknown): SessionLiveEventEntry {
  return { type: 'event', event: { seq, time: seq * 100, type, data } as SessionEvent }
}

function assembler(entries: readonly SessionLiveEventEntry[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, false)
  value.flush()
  return value
}

function deliveryData(value: ConversationNodeAssembler): DeliveryTaskChatData | undefined {
  const snapshot = value.snapshot('chat') as ChatSnapshot
  return [...snapshot.nodes.values()][0]?.data as DeliveryTaskChatData | undefined
}

/** A create delivery change opening a fresh l2 task. */
function createChange(): Record<string, unknown> {
  return {
    kind: 'delivery/change',
    version: 1,
    operation: 'create',
    task: {
      id: 'task-1',
      revision: 1,
      objective: 'Ship the delivery discipline',
      phase: 'created',
      level: 'l2',
      changeCount: 0,
      designCount: 0,
      specCount: 0,
    },
    createdAt: 100,
    updatedAt: 100,
  }
}

/** A record-* delivery change carrying text and a post-increment count. */
function recordChange(
  operation: 'record-change' | 'record-design' | 'record-spec',
  revision: number,
  text: string,
): Record<string, unknown> {
  const countKey = operation === 'record-change' ? 'changeCount'
    : operation === 'record-design' ? 'designCount' : 'specCount'
  return {
    kind: 'delivery/change',
    version: 1,
    operation,
    ref: { id: 'task-1', revision },
    text,
    [countKey]: 1,
    updatedAt: 100,
  }
}

/** An advance delivery change moving the task to the next phase. */
function advanceChange(revision: number, phase: string): Record<string, unknown> {
  return {
    kind: 'delivery/change',
    version: 1,
    operation: 'advance',
    task: {
      id: 'task-1',
      revision,
      objective: 'Ship the delivery discipline',
      phase,
      level: 'l2',
      changeCount: 1,
      designCount: 1,
      specCount: 1,
    },
    createdAt: 100,
    updatedAt: 100,
  }
}

describe('delivery-task Conversation Definition', () => {
  it('folds a full lifecycle into the task card timeline', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'delivery/change', createChange()),
      at(4, 'delivery/change', recordChange('record-design', 2, 'design one')),
      at(5, 'delivery/change', advanceChange(4, 'designed')),
      at(6, 'delivery/change', recordChange('record-spec', 5, 'spec one')),
      at(7, 'delivery/change', advanceChange(6, 'specified')),
      at(8, 'delivery/change', recordChange('record-change', 7, 'change one')),
      at(9, 'delivery/change', advanceChange(8, 'implemented')),
    ])
    const data = deliveryData(value)
    expect(data).toMatchObject({
      objective: 'Ship the delivery discipline',
      level: 'l2',
      phase: 'implemented',
      changeCount: 1,
      designCount: 1,
      specCount: 1,
      cleared: false,
    })
    expect(data?.events.map(event => event.operation)).toEqual([
      'create', 'record-design', 'advance', 'record-spec', 'advance', 'record-change', 'advance',
    ])
    expect(data?.events[0]?.phase).toBe('created')
    expect(data?.events[1]?.text).toBe('design one')
    const node = [...(value.snapshot('chat') as ChatSnapshot).nodes.values()][0]!
    expect(node.anchorSeq).toBe(3)
    expect(node.kind).toBe('delivery-task')
  })

  it('marks a cleared task and keeps its tombstone event', () => {
    const value = assembler([
      at(1, 'delivery/change', createChange()),
      at(2, 'delivery/change', {
        kind: 'delivery/change', version: 1, operation: 'clear',
        cleared: { id: 'task-1', revision: 2 }, clearedAt: 200,
      }),
    ])
    const data = deliveryData(value)
    expect(data?.cleared).toBe(true)
    expect(data?.events.map(event => event.operation)).toEqual(['create', 'clear'])
  })

  it('keeps unrelated events out of the fold', () => {
    const value = assembler([
      at(1, 'delivery/change', createChange()),
      at(2, 'turn/start', { turn: 1 }),
      at(3, 'delivery/change', recordChange('record-change', 2, 'a later change')),
    ])
    const data = deliveryData(value)
    expect(data?.events.map(event => event.operation)).toEqual(['create', 'record-change'])
  })

  it('rejects a non-create start and ignores a missing start for the view node', () => {
    const invalidStart = {
      event: at(2, 'delivery/change', recordChange('record-change', 2, 'x')).event,
      role: 'start',
      location: { kind: 'unresolved' },
    } as const
    const emptyContext: Parameters<typeof deliveryTaskDefinition.start>[0] = {
      key: 'delivery-task:task-1', kind: 'delivery-task', id: 'task-1',
      matches: [invalidStart], start: invalidStart, state: undefined, current: new Map(),
    }
    const reader: Parameters<typeof deliveryTaskDefinition.start>[2] = { previous: () => undefined }
    expect(() => deliveryTaskDefinition.start(emptyContext, invalidStart, reader))
      .toThrow('delivery-task start requires a create delivery change')

    const startEvent = at(1, 'delivery/change', createChange())
    const start = { event: startEvent.event, role: 'start', location: { kind: 'unresolved' } } as const
    const startedContext = { ...emptyContext, matches: [start], start }
    const state = deliveryTaskDefinition.start(startedContext, start, reader)
    expect(deliveryTaskDefinition.target).toBe('chat')
    expect(deliveryTaskDefinition.buildViewNode?.({
      ...startedContext, matches: [], start: undefined,
    })).toBeNull()

    const updateContext: Parameters<typeof deliveryTaskDefinition.update>[0] = { ...startedContext, state }
    const unrelated = { event: at(3, 'turn/start', { turn: 1 }).event, role: 'update', location: { kind: 'unresolved' } } as const
    expect(deliveryTaskDefinition.update(updateContext, unrelated)).toBe(state)
  })

  it('updates the card live as the task advances through appended events', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'delivery/change', createChange()),
    ])
    expect(deliveryData(value)?.phase).toBe('created')
    expect(deliveryData(value)?.events).toHaveLength(1)

    value.append(at(4, 'delivery/change', recordChange('record-design', 2, 'design one')))
    value.flush()
    expect(deliveryData(value)?.designCount).toBe(1)
    expect(deliveryData(value)?.events).toHaveLength(2)

    value.append(at(5, 'delivery/change', advanceChange(4, 'designed')))
    value.flush()
    const advanced = deliveryData(value)
    expect(advanced?.phase).toBe('designed')
    expect(advanced?.events).toHaveLength(3)
    expect(advanced?.events[2]?.phase).toBe('designed')

    // A record after the advance still folds into the same card.
    value.append(at(6, 'delivery/change', recordChange('record-spec', 5, 'spec one')))
    value.flush()
    expect(deliveryData(value)?.specCount).toBe(1)
    expect(deliveryData(value)?.events).toHaveLength(4)
  })

  it('keeps one card per task and folds a second task independently', () => {
    const value = assembler([
      at(1, 'delivery/change', createChange()),
      at(2, 'delivery/change', advanceChange(2, 'implemented')),
      at(3, 'delivery/change', recordChange('record-change', 3, 'first task change')),
      at(4, 'delivery/change', {
        kind: 'delivery/change', version: 1, operation: 'clear',
        cleared: { id: 'task-1', revision: 4 }, clearedAt: 400,
      }),
      at(5, 'delivery/change', {
        kind: 'delivery/change', version: 1, operation: 'create',
        task: { ...(createChange().task as Record<string, unknown>), id: 'task-2' },
        createdAt: 500, updatedAt: 500,
      }),
    ])
    const nodes = [...(value.snapshot('chat') as ChatSnapshot).nodes.values()]
    expect(nodes).toHaveLength(2)
    // The two tasks share an objective in this fixture, so distinguish them by
    // the fold outcome: only the cleared task carries the tombstone.
    const cleared = nodes.find(node => (node.data as DeliveryTaskChatData).cleared)
    const live = nodes.find(node => !(node.data as DeliveryTaskChatData).cleared)
    expect(cleared).toBeDefined()
    expect(live).toBeDefined()
    expect((cleared?.data as DeliveryTaskChatData).events).toHaveLength(4)
    expect((live?.data as DeliveryTaskChatData).events).toHaveLength(1)
    expect((live?.data as DeliveryTaskChatData).phase).toBe('created')
  })
})
