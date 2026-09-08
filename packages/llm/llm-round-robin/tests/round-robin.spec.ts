import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ReasoningEffortId,
  ToolCallId,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelReasoningInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as roundRobin from '../src/index.ts'

type ScriptEntry = Iterable<StreamChunk>

/** Scripts one exact model route per call, recording every request it served. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly entries: ScriptEntry[],
    private readonly reasoning?: LlmModelReasoningInfo,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): ReturnType<LlmAdapter['resolveModel']> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('round-robin test script exhausted')
    yield* entry
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function harness(
  candidates: roundRobin.CandidateRoute[],
  adapter: ScriptedAdapter,
  when?: roundRobin.CandidateRoute[],
): Promise<{ ctx: Context; disposeAdapter: () => void }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin((inner: Context) => {
    roundRobin.apply(inner, when === undefined ? { candidates } : { when, candidates })
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  const disposeAdapter = ctx.llm.registerAdapter(['mock', 'other'], adapter)
  return { ctx, disposeAdapter }
}

function route(provider: string, model: string): roundRobin.CandidateRoute {
  return { provider, model }
}

/**
 * Create an agent whose session-selected model is `primary` — the anchor of the
 * rotation. Model selection re-asserts `primary` at every step, which is how
 * the Web Models page keeps the selected model stable across steps.
 */
async function createAgent(
  ctx: Context,
  sessionId: string,
  anchor: { provider: string; model: string; reasoningEffort?: ReturnType<typeof ReasoningEffortId> },
): Promise<Agent> {
  const { agent } = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    agentOptions: { provider: 'mock', model: anchor.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, {
        current: anchor,
        assembled: undefined,
      })
    },
  })
  return agent
}

function waitForIdle(agent: Agent): Promise<void> {
  return agent.whenIdle()
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('round-robin rotation', () => {
  it('uses the anchor on the first step and rotates to the candidate on the second', async () => {
    const adapter = new ScriptedAdapter([textResponse('first'), textResponse('second')])
    ;({ ctx: context } = await harness([route('mock', 'candidate')], adapter))
    const agent = await createAgent(context, 'rotate-single', { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate' },
    ])
  })

  it('rotates through multiple candidates and back to the anchor', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('anchor'),
      textResponse('candidate one'),
      textResponse('candidate two'),
      textResponse('anchor again'),
    ])
    ;({ ctx: context } = await harness(
      [route('mock', 'candidate-one'), route('mock', 'candidate-two')],
      adapter,
    ))
    const agent = await createAgent(context, 'rotate-multi', { provider: 'mock', model: 'primary' })

    for (const text of ['a', 'b', 'c', 'd']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await waitForIdle(agent)
    }

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate-one' },
      { provider: 'mock', model: 'candidate-two' },
      { provider: 'mock', model: 'primary' },
    ])
  })

  it('rotates across steps within one turn through a tool loop', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('c1', 'echo', { text: 'ping' }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness([route('mock', 'candidate')], adapter))
    context.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo back',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${args.text}` }]
      },
    }))
    const agent = await createAgent(context, 'rotate-tool-loop', { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the tool' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate' },
    ])
  })

  it('is a no-op when no candidates are configured', async () => {
    const adapter = new ScriptedAdapter([textResponse('one'), textResponse('two')])
    ;({ ctx: context } = await harness([], adapter))
    const agent = await createAgent(context, 'rotate-empty', { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'primary' },
    ])
  })

  it('deduplicates a candidate equal to the anchor', async () => {
    const adapter = new ScriptedAdapter([textResponse('one'), textResponse('two')])
    // The only candidate is the anchor itself, so there is nothing to rotate to.
    ;({ ctx: context } = await harness([route('mock', 'primary')], adapter))
    const agent = await createAgent(context, 'rotate-self', { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'primary' },
    ])
  })

  it('clears the anchor reasoning effort when rotating to a candidate', async () => {
    const effort = ReasoningEffortId('high')
    const adapter = new ScriptedAdapter(
      [textResponse('one'), textResponse('two')],
      { efforts: [{ id: effort, name: 'High' }] },
    )
    ;({ ctx: context } = await harness([route('mock', 'candidate')], adapter))
    const agent = await createAgent(context, 'rotate-effort', {
      provider: 'mock',
      model: 'primary',
      reasoningEffort: effort,
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests[0]?.reasoningEffort).toBe(effort)
    expect(adapter.requests[1]?.reasoningEffort).toBeUndefined()
  })

  it('rotates only when the anchor model is listed in the `when` filter', async () => {
    const adapter = new ScriptedAdapter([textResponse('one'), textResponse('two')])
    ;({ ctx: context } = await harness(
      [route('mock', 'candidate')],
      adapter,
      [route('mock', 'primary')],
    ))
    const agent = await createAgent(context, 'rotate-when-match', { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate' },
    ])
  })

  it('does not rotate when the anchor model is outside the `when` filter', async () => {
    const adapter = new ScriptedAdapter([textResponse('one'), textResponse('two')])
    ;({ ctx: context } = await harness(
      [route('mock', 'candidate')],
      adapter,
      [route('mock', 'unrelated')],
    ))
    const agent = await createAgent(context, 'rotate-when-miss', { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'primary' },
    ])
  })

  it('rotates when the anchor matches one of several `when` models', async () => {
    const adapter = new ScriptedAdapter([textResponse('one'), textResponse('two')])
    ;({ ctx: context } = await harness(
      [route('mock', 'candidate')],
      adapter,
      [route('other', 'x'), route('mock', 'primary')],
    ))
    const agent = await createAgent(context, 'rotate-when-multi', { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate' },
    ])
  })

  it('rejects a duplicate candidate route', () => {
    expect(() => {
      roundRobin.apply(new Context(), {
        candidates: [route('mock', 'a'), route('mock', 'a')],
      })
    }).toThrow(/duplicate candidate route/)
  })

  it('rejects a duplicate `when` route', () => {
    expect(() => {
      roundRobin.apply(new Context(), {
        when: [route('mock', 'a'), route('mock', 'a')],
        candidates: [route('mock', 'b')],
      })
    }).toThrow(/duplicate when route/)
  })
})
