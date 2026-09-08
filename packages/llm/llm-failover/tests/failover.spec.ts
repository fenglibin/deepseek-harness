import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  LlmError,
  RATE_LIMIT_CODE,
  createUserMessage,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import * as failover from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

/** Scripts one exact model route per call, like the retry executor's fixture. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('failover test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configureRetryPolicies(
    policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
  ): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined
        ? undefined
        : resolveRetryPolicy(policy, `failover test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
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

/** A short bounded policy so any delegated retry wait stays 1 ms in tests. */
function normalConfig(): RetryPolicyConfig {
  return {
    mode: 'normal',
    maxRetries: 2,
    backoff: {
      initialDelayMs: 1,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      rateLimitDelayMs: 1,
    },
  }
}

async function harness(
  candidates: failover.CandidateRoute[],
  adapter: ScriptedAdapter,
  policies: Readonly<Record<string, RetryPolicyConfig | undefined>> = { mock: normalConfig() },
): Promise<{ ctx: Context; disposeAdapter: () => void }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  adapter.configureRetryPolicies(policies)
  // Failover first, then retry, matching the production cordis row order. The
  // retry executor declares its service injections, so its plugin record must
  // carry them for `ctx.plugin` to provision the projection registry.
  await ctx.plugin((inner: Context) => { failover.apply(inner, { candidates }) })
  await ctx.plugin(Object.assign(
    (inner: Context) => { retry.apply(inner, {}, { random: () => 0.5 }) },
    { inject: retry.inject },
  ))
  await ctx.plugin(AgentLoop, { agents: [] })
  const disposeAdapter = ctx.llm.registerAdapter(['mock', 'other'], adapter)
  return { ctx, disposeAdapter }
}

function route(provider: string, model: string): failover.CandidateRoute {
  return { provider, model }
}

function waitForIdle(agent: Agent): Promise<void> {
  return agent.whenIdle()
}

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

describe('rate-limit failover', () => {
  it('fails over to the first candidate on a rate-limit failure without waiting', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('throttled', RATE_LIMIT_CODE, { status: 429 }),
      textResponse('recovered via candidate'),
    ])
    ;({ ctx: context } = await harness([route('mock', 'candidate')], adapter))
    const agent = context.agentLoop.create(SessionId('failover-single'), { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate' },
    ])
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered via candidate' }],
    })
  })

  it('rotates through multiple candidates before delegating', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('throttled primary', RATE_LIMIT_CODE, { status: 429 }),
      new LlmError('throttled first candidate', RATE_LIMIT_CODE, { status: 429 }),
      textResponse('recovered via second candidate'),
    ])
    ;({ ctx: context } = await harness(
      [route('mock', 'candidate-one'), route('mock', 'candidate-two')],
      adapter,
    ))
    const agent = context.agentLoop.create(SessionId('failover-rotate'), { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate-one' },
      { provider: 'mock', model: 'candidate-two' },
    ])
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('delegates to the retry policy after every candidate is throttled', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('throttled primary', RATE_LIMIT_CODE, { status: 429 }),
      new LlmError('throttled candidate', RATE_LIMIT_CODE, { status: 429 }),
      textResponse('recovered after wait'),
    ])
    ;({ ctx: context } = await harness([route('mock', 'candidate')], adapter))
    const agent = context.agentLoop.create(SessionId('failover-exhaust'), { provider: 'mock', model: 'primary' })

    const idle = waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate' },
      { provider: 'mock', model: 'candidate' },
    ])
    const retries = agent.session.events.filter(event => event.type === 'llm/retry')
    expect(retries).toHaveLength(1)
    expect(retries[0]?.data.failure.code).toBe(RATE_LIMIT_CODE)
  })

  it('passes non-rate-limit failures through without failing over', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('recovered on primary'),
    ])
    ;({ ctx: context } = await harness([route('mock', 'candidate')], adapter))
    const agent = context.agentLoop.create(SessionId('failover-non-429'), { provider: 'mock', model: 'primary' })

    const idle = waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'primary' },
    ])
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(true)
  })

  it('is a no-op when no candidates are configured', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('throttled', RATE_LIMIT_CODE, { status: 429 }),
      textResponse('recovered after wait'),
    ])
    ;({ ctx: context } = await harness([], adapter))
    const agent = context.agentLoop.create(SessionId('failover-empty'), { provider: 'mock', model: 'primary' })

    const idle = waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'primary' },
    ])
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
  })

  it('skips a candidate equal to the current model', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('throttled', RATE_LIMIT_CODE, { status: 429 }),
      textResponse('recovered after wait'),
    ])
    // The only candidate is the primary itself, so there is nothing to fail over to.
    ;({ ctx: context } = await harness([route('mock', 'primary')], adapter))
    const agent = context.agentLoop.create(SessionId('failover-self'), { provider: 'mock', model: 'primary' })

    const idle = waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'primary' },
    ])
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
  })

  it('wins over model selection when rewriting the failover route', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('throttled', RATE_LIMIT_CODE, { status: 429 }),
      textResponse('recovered via candidate'),
    ])
    ;({ ctx: context } = await harness([route('mock', 'candidate')], adapter))
    const { agent } = await context.agents.create({
      sessionId: SessionId('failover-ordering'),
      agentOptions: { provider: 'mock', model: 'primary' },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, {
          current: { provider: 'mock', model: 'primary' },
          assembled: undefined,
        })
      },
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate' },
    ])
  })

  it('resets the rotation for each step', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('throttled', RATE_LIMIT_CODE, { status: 429 }),
      textResponse('turn one recovered'),
      new LlmError('throttled', RATE_LIMIT_CODE, { status: 429 }),
      textResponse('turn two recovered'),
    ])
    ;({ ctx: context } = await harness([route('mock', 'candidate')], adapter))
    // Model selection re-asserts the primary route at every step, so a fresh
    // step's throttle must rotate through the candidate pool again.
    const { agent } = await context.agents.create({
      sessionId: SessionId('failover-reset'),
      agentOptions: { provider: 'mock', model: 'primary' },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, {
          current: { provider: 'mock', model: 'primary' },
          assembled: undefined,
        })
      },
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate' },
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate' },
    ])
  })

  it('does not re-select a candidate that failed with a non-throttle error', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('throttled', RATE_LIMIT_CODE, { status: 429 }),
      new LlmError('busy candidate', 'SERVER'),
      new LlmError('throttled again', RATE_LIMIT_CODE, { status: 429 }),
      textResponse('recovered via second candidate'),
    ])
    ;({ ctx: context } = await harness(
      [route('mock', 'candidate-one'), route('mock', 'candidate-two')],
      adapter,
    ))
    const { agent } = await context.agents.create({
      sessionId: SessionId('failover-non-throttle-candidate'),
      agentOptions: { provider: 'mock', model: 'primary' },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, {
          current: { provider: 'mock', model: 'primary' },
          assembled: undefined,
        })
      },
    })

    const idle = waitForIdle(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await vi.advanceTimersByTimeAsync(1)
    await idle

    // candidate-one fails with a non-throttle error after failover; the next
    // throttle must move on to candidate-two instead of re-selecting it.
    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model }))).toEqual([
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate-one' },
      { provider: 'mock', model: 'primary' },
      { provider: 'mock', model: 'candidate-two' },
    ])
  })

  it('rejects a duplicate candidate route', () => {
    expect(() => {
      failover.apply(new Context(), {
        candidates: [route('mock', 'a'), route('mock', 'a')],
      })
    }).toThrow(/duplicate candidate route/)
  })
})
