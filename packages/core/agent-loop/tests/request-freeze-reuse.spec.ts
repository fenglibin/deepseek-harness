/**
 * 请求不可变性：消息对象身份只被深冻结一次，该证明在本循环实例内复用，
 * 因此每轮请求的冻结成本不随历史长度增长。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as values from '@deepseek-ai/dsh-util-values'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.reverse()) await cleanup()
  } finally {
    cleanups.length = 0
    vi.restoreAllMocks()
  }
})

/**
 * 装配一个真实 AgentLoop，其依赖与既有 agent-loop 套件一致。
 * @param adapter - 该循环唯一的模型适配器。
 * @returns 已装配的根上下文。
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/**
 * 发送一条用户消息并等待该轮结束。
 * @param agent - 目标 agent。
 * @param text - 用户消息正文。
 */
async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/**
 * 统计一次深冻结将遍历的对象节点数。
 *
 * 冻结的成本是遍历的节点数而非调用次数：`deepFreeze` 用显式栈走完整图。
 * 复用的证明让后续轮次不再重走已被证明的历史，因此这个数才是该优化的
 * 直接观察量。
 * @param root - 待冻结的值。
 * @returns 可达并可冻结的对象节点数。
 */
function countNodes(root: unknown): number {
  const seen = new WeakSet<object>()
  const stack: unknown[] = [root]
  let count = 0
  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || typeof value !== 'object' || value instanceof AbortSignal) continue
    if (seen.has(value as object)) continue
    seen.add(value as object)
    count++
    for (const child of Object.values(value as object)) stack.push(child)
  }
  return count
}

/**
 * 递归断言一个值及其后代都已被冻结，跳过必须保持可变的取消信号。
 * @param value - 待检查的值。
 */
function expectFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object' || value instanceof AbortSignal) return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectFrozen(child)
}

/**
 * 在真实循环上跑若干轮，返回每轮请求构造时深冻结遍历的节点数。
 * @param turns - 要跑的轮数。
 * @returns 每轮遍历的节点数，按轮次顺序。
 */
async function nodesPerTurn(turns: number): Promise<{ traversed: number[]; messageCounts: number[] }> {
  const adapter = new MockAdapter(Array.from({ length: turns }, (_, index) => textResponse(`t${index}`)))
  const ctx = await harness(adapter)
  const agent = ctx.agentLoop.create(SessionId(`freeze-${turns}`), { provider: 'mock', model: 'mock' })
  const real = values.deepFreeze
  let traversed = 0
  vi.spyOn(values, 'deepFreeze').mockImplementation(((value: never) => {
    traversed += countNodes(value)
    return real(value)
  }) as never)

  const result: number[] = []
  const messageCounts: number[] = []
  for (let turn = 0; turn < turns; turn++) {
    traversed = 0
    await send(agent, `message ${turn}`)
    result.push(traversed)
    messageCounts.push(adapter.requests[turn]?.messages.length ?? 0)
  }
  return { traversed: result, messageCounts }
}

describe('循环持有的请求冻结证明', () => {
  it('每轮的冻结遍历量不随历史长度增长', async () => {
    const { traversed, messageCounts } = await nodesPerTurn(5)

    // 历史确实在增长：5 轮的请求消息数应为 1、3、5、7、9。
    expect(messageCounts).toEqual([1, 3, 5, 7, 9])
    // 首轮没有可复用的证明，需要遍历已恢复/新增的全部消息。
    const [first, ...later] = traversed as [number, ...number[]]
    expect(first).toBeGreaterThan(0)
    // 后续每轮只遍历本轮新增的消息，因此遍历量落在一个窄带内而与历史长度
    // 无关（实测 77、76、76、76）。若证明未被复用，每轮都会重新走完整段
    // 历史，遍历量随 messageCounts 每轮 +2 条消息持续增长、带宽发散。
    const spread = Math.max(...later) - Math.min(...later)
    expect(spread).toBeLessThanOrEqual(4)
    // 且量级与历史长度脱钩：末轮有 9 条消息，线性重冻结会遍历到数百个节点。
    expect(Math.max(...later)).toBeLessThan(messageCounts.at(-1)! * 20)
  })

  it('派发的请求仍被完整冻结，且取消信号保持可变', async () => {
    const adapter = new MockAdapter([textResponse('frozen')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('freeze-whole'), { provider: 'mock', model: 'mock' })

    await send(agent, 'hello')

    const request = adapter.requests[0]
    if (request === undefined) throw new Error('the mock adapter recorded no request')
    expect(isAgentLoopRequest(request)).toBe(true)
    expectFrozen(request)
    // 流式请求必须在派发后仍可取消，因此信号不能被冻结。
    expect(Object.isFrozen(request.signal)).toBe(false)
  })

  it('同一消息对象在多次请求间复用，替换产生的新对象被重新冻结', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('freeze-identity'), { provider: 'mock', model: 'mock' })

    await send(agent, 'first')
    const first = adapter.requests[0]?.messages ?? []
    await send(agent, 'second')
    const second = adapter.requests[1]?.messages ?? []

    // 派生按增量缓存，因此第一轮的整段历史在第二轮中是同一批对象，命中证明。
    expect(first.length).toBeGreaterThan(0)
    expect(second.slice(0, first.length)).toEqual(first)
    for (const [index, message] of first.entries()) expect(second[index]).toBe(message)
    // 第二轮在尾部追加了助手回复与新的用户消息，它们是新对象，必须被纳入本次遍历。
    expect(second.length).toBeGreaterThan(first.length)
    for (const message of second) expect(Object.isFrozen(message)).toBe(true)
  })
})
