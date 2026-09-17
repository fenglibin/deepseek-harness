import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import DeliveryService from '@deepseek-ai/dsh-delivery'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { LlmRuntime, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import * as promptConfig from '@deepseek-ai/dsh-command-prompt-config'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolDelivery from '@deepseek-ai/dsh-tool-delivery'
import { orderItemsByMarkdown, renderTasksMarkdown } from '@deepseek-ai/dsh-tool-delivery/src/index.ts'
import { ACCEPTANCE_RECORD_PREFIX } from '@deepseek-ai/dsh-tool-delivery/src/verification.ts'

const testToolSignal = new AbortController().signal

/**
 * Whether a command runs `openspec validate` without naming what to validate.
 *
 * The real CLI exits non-zero on a bare `openspec validate`. The stub models
 * that because an untargeted command is exactly how a recorded empty change id
 * blocked every non-l2 acceptance; a stub that returned success for anything
 * would hide that defect rather than catch its return.
 * @param command - the shell command under test.
 * @returns true when the command names no validation target.
 */
function validatesNothing(command: string): boolean {
  const match = /^\s*openspec\s+validate\b(.*)$/.exec(command)
  if (match === null) return false
  return !(match[1] ?? '').split(/\s+/).some(token => token !== '' && !token.startsWith('-'))
}

/** In-memory shell whose `run` returns a fixed outcome, for validation tests. */
class StubShell extends ShellExecutor {
  /** Every command run through this shell, in order. */
  readonly commands: string[] = []

  constructor(ctx: Context, private readonly outcome: Partial<ShellRunResult> = {}) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: 60_000,
      stdoutMaxBytes: 64_000,
      sandboxPolicy: undefined,
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.commands.push(spec.command)
    const outcome = validatesNothing(spec.command)
      ? { exitCode: 1, stdout: { text: 'Nothing to validate.', truncated: false } }
      : this.outcome
    return {
      exitCode: outcome.exitCode ?? 0,
      signal: outcome.signal ?? null,
      timedOut: outcome.timedOut ?? false,
      aborted: outcome.aborted ?? false,
      timeoutMs: spec.timeoutMs,
      stdout: outcome.stdout ?? { text: '', truncated: false },
      stderr: outcome.stderr ?? { text: '', truncated: false },
    }
  }

  start(_spec: ShellExecSpec): ShellProcess {
    throw new Error('StubShell.start is not used by validation tests')
  }
}

/**
 * In-memory settings provider: the real Service Definition, so
 * `describe()`/`installSection` behave exactly as a file provider's would.
 */
class InMemorySettings extends SettingsProvider {
  static Config = z.object({})
  readonly writable = true
  /** One section per namespace, as a provider's raw document holds them. */
  private readonly sections = new Map<string, Record<string, unknown>>()
  protected async load(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.sections)
  }
  protected async persist(ns: string, section: Record<string, unknown>): Promise<void> {
    this.sections.set(ns, section)
  }
}

/** Build one registry-compatible live agent. */
function stubAgent(rawId: string, supplied?: Session): Agent {
  const session = supplied ?? Session.create(SessionId(rawId))
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    ctx: new Context(),
    status: 'running',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

/**
 * Minimal settings provider that resolves the delivery policy section and,
 * when given one, a `prompt-commands` section the acceptance gate reads prompt
 * bodies from. `describe()` serves the same values so the cross-namespace read
 * sees exactly what the editor would.
 */
class StubSettings {
  private readonly sections = new Map<string, unknown>()

  constructor(
    private readonly override: Record<string, unknown>,
    commands?: readonly { name: string; prompt: string }[],
  ) {
    // In a real deployment `command-prompt-config` registers this namespace;
    // the harness composes only the delivery plugin, so the section is seeded
    // directly and `describe()` serves it like any other registration.
    if (commands !== undefined) this.sections.set('prompt-commands', { commands })
  }

  installSection<T>(
    _owner: Context,
    ns: string,
    _schema: unknown,
    entry: T,
    hooks: { setSource(current: () => T): void; onChange(): void },
  ): void {
    expect(ns).toBe('delivery')
    const merged = { ...(entry as Record<string, unknown>), ...this.override } as T
    this.sections.set(ns, merged)
    hooks.setSource(() => merged)
    hooks.onChange()
  }

  /** Every registered namespace with its resolved value. */
  describe(): readonly { ns: string; value: unknown }[] {
    return [...this.sections].map(([ns, value]) => ({ ns, value }))
  }
}

/**
 * Scripted LLM whose grading replies the test decides, so a graded tier is
 * deterministic without a provider. Any other call is a defect: only the
 * grading path reaches the model.
 */
class StubLlm extends LlmRuntime {
  /** Every request this stub was asked to serve, in order. */
  readonly requests: GenerateOptions[] = []

  constructor(ctx: Context, private readonly reply: string | (() => string) = 'l0') {
    super(ctx)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = typeof this.reply === 'function' ? this.reply() : this.reply
    yield { type: 'text-delta', text } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  }
}

/** The scripted grading model a harness composed, for asserting its calls. */
function llmOf(ctx: Context): StubLlm {
  const llm = ctx.get('llm')
  if (!(llm instanceof StubLlm)) throw new Error('expected the scripted grading model')
  return llm
}

async function harness(
  config: toolDelivery.Config = {},
  shellOutcome: Partial<ShellRunResult> = {},
  settings?: StubSettings,
  gradingReply: string | (() => string) = 'l0',
) {
  const ctx = new Context()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-delivery-'))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem, { cwd })
  await ctx.plugin(StubShell, shellOutcome)
  await ctx.plugin(StubLlm, gradingReply)
  if (settings !== undefined) ctx.provide('settings', settings)
  await ctx.plugin(DeliveryService)
  const fiber = await ctx.plugin(toolDelivery, config)
  // The agent carries its own route so grading has a provider and model to
  // call; without one every grade would take the no-route fallback and the
  // scripted reply below would never be consulted.
  const agent = stubAgent(`delivery-tool-${Math.random()}`)
  agent.options.provider = 'stub'
  agent.options.model = 'stub-grader'
  ctx.agents.register(agent)
  return { ctx, fiber, agent, cwd }
}

/** Dispatch one pre-step boundary for the delivery auto-detect listener. */
async function preStep(ctx: Context, agent: Agent, messages: UserMessage[]): Promise<void> {
  const signal = new AbortController().signal
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

/** Execute one registered delivery tool, optionally without a calling agent. */
async function execute(ctx: Context, name: string, args: unknown, agent?: Agent): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${Math.random()}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** Parse the compact JSON returned by a successful tool. */
function resultJson(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected tool success')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  return JSON.parse(block.text) as Record<string, unknown>
}

/** The text of a failed tool result, for asserting what a gate reported. */
function errorText(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  return block.text
}

/** Return the task sub-object from a successful tool result. */
function resultTask(result: ToolExecutionResult): Record<string, unknown> {
  const task = resultJson(result)['task']
  if (typeof task !== 'object' || task === null) throw new Error('expected returned task')
  return task as Record<string, unknown>
}

describe('tool-delivery registration', () => {
  it('registers the seven delivery tools by default', async () => {
    const { ctx } = await harness()
    for (const name of ['get_delivery_task', 'create_delivery_task', 'record_change', 'record_design', 'mark_analysis_done', 'record_spec', 'advance_delivery_task']) {
      expect(ctx.tools.get(name)).toBeDefined()
    }
  })

  it('registers a guidance section telling the model when to use delivery tools', async () => {
    const { ctx } = await harness()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === 'tool:delivery')
    expect(section).toBeDefined()
    expect(section?.text).toContain('create_delivery_task')
    expect(section?.text).toContain('.dsh/changes/')
    expect(section?.text).toContain('.dsh/design/')
    expect(section?.text).toContain('openspec/changes/')
    expect(section?.text).toContain('todo_write')
  })

  it('registers no tools when disabled', async () => {
    const { ctx } = await harness({ enabled: false })
    expect(ctx.tools.get('create_delivery_task')).toBeUndefined()
  })

  it('registers no tools when enforcement is off', async () => {
    const { ctx } = await harness({ enforcement: 'off' })
    expect(ctx.tools.get('create_delivery_task')).toBeUndefined()
  })

  it('rejects an invalid enforcement value before registering anything', () => {
    const ctx = new Context()
    expect(() => { toolDelivery.apply(ctx, { enforcement: 'banana' }) }).toThrow(TypeError)
  })

  it('rejects an invalid design threshold before registering anything', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(DeliveryService)
    expect(() => { toolDelivery.apply(ctx, { designThreshold: { todoCount: 0 } }) }).toThrow(TypeError)
    expect(() => { toolDelivery.apply(ctx, { designThreshold: { touchedFiles: 1.5 } }) }).toThrow(TypeError)
    expect(ctx.tools.get('create_delivery_task')).toBeUndefined()
  })

  it('rejects an empty grading prompt before registering anything', async () => {
    // An empty prompt makes every grading call answer with nothing and fall
    // back to l1, so it is refused rather than silently degrading every grade.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(DeliveryService)
    expect(() => { toolDelivery.apply(ctx, { gradingPrompt: '   ' }) }).toThrow(TypeError)
    expect(ctx.tools.get('create_delivery_task')).toBeUndefined()
  })

  it('rejects an invalid openspec threshold before registering anything', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(DeliveryService)
    expect(() => { toolDelivery.apply(ctx, { openspecThreshold: { descriptionChars: 0 } }) }).toThrow(TypeError)
    expect(() => { toolDelivery.apply(ctx, { openspecThreshold: { descriptionChars: 1.5 } }) }).toThrow(TypeError)
    expect(() => { toolDelivery.apply(ctx, { openspecThreshold: { todoCount: 0 } }) }).toThrow(TypeError)
    expect(ctx.tools.get('create_delivery_task')).toBeUndefined()
  })
})

describe('tool-delivery workflow', () => {
  it('creates, records, and advances a task through the tools', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'tool workflow' }, agent))
    expect(created).toMatchObject({ phase: 'created', level: 'l0', changeCount: 0 })

    const recorded = resultTask(await execute(ctx, 'record_change', {
      task_id: created['id'],
      revision: created['revision'],
      text: 'the fix',
    }, agent))
    expect(recorded).toMatchObject({ changeCount: 1, revision: 2 })

    const implemented = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: recorded['id'],
      revision: recorded['revision'],
      phase: 'implemented',
    }, agent))
    expect(implemented).toMatchObject({ phase: 'implemented' })
  })

  it('blocks advancing to implemented without a change record under stateful', async () => {
    const { ctx, agent } = await harness({ enforcement: 'stateful' })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'gated' }, agent))
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: created['id'],
      revision: created['revision'],
      phase: 'implemented',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('allows advancing without a change record under advisory', async () => {
    const { ctx, agent } = await harness({ enforcement: 'advisory' })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'advised' }, agent))
    const implemented = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: created['id'],
      revision: created['revision'],
      phase: 'implemented',
    }, agent))
    expect(implemented).toMatchObject({ phase: 'implemented', changeCount: 0 })
  })

  it('rejects phase skips through the tools', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'skip' }, agent))
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: created['id'],
      revision: created['revision'],
      phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('reports an invalid transition, not a record gate, for a phase outside the level order', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'order', level: 'l0' }, agent))
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: created['id'],
      revision: created['revision'],
      phase: 'designed',
    }, agent)
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('DELIVERY_INVALID_TRANSITION')
  })
})

describe('tool-delivery presentation and authority', () => {
  it('uses args-only generic render intent for every tool', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.get('get_delivery_task')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'Read delivery task', kind: 'read',
    })
    expect(ctx.tools.get('create_delivery_task')?.presentCall?.({ objective: 'ship' })).toEqual({
      card: 'generic', title: 'Create delivery task', kind: 'other', rawInput: 'ship',
    })
    expect(ctx.tools.get('record_change')?.presentCall?.({ task_id: 'task-1', revision: 1, text: 'the fix' })).toEqual({
      card: 'generic', title: 'Record change', kind: 'other', rawInput: 'the fix',
    })
    expect(ctx.tools.get('record_design')?.presentCall?.({ task_id: 'task-1', revision: 1, text: 'the design' })).toEqual({
      card: 'generic', title: 'Record design', kind: 'other', rawInput: 'the design',
    })
    expect(ctx.tools.get('record_spec')?.presentCall?.({
      task_id: 'task-1', revision: 1, change_id: 'add-thing', kind: 'spec', capability: 'thing', text: 'the spec',
    })).toEqual({
      card: 'generic', title: 'Record spec', kind: 'other', rawInput: 'the spec',
    })
    expect(ctx.tools.get('advance_delivery_task')?.presentCall?.({ task_id: 'task-1', revision: 1, phase: 'implemented' })).toEqual({
      card: 'generic', title: 'Advance delivery task to implemented', kind: 'other', rawInput: 'task-1',
    })
  })

  it('reads null before any task exists', async () => {
    const { ctx, agent } = await harness()
    expect(resultJson(await execute(ctx, 'get_delivery_task', {}, agent))).toEqual({ task: null })
  })

  it('creates a task at an explicit level', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l2', level: 'l2' }, agent))
    expect(created).toMatchObject({ level: 'l2', phase: 'created' })
  })

  it('rejects calls without a calling agent', async () => {
    const { ctx } = await harness()
    const result = await execute(ctx, 'get_delivery_task', {})
    expect(result.error?.info?.code).toBe('DELIVERY_TOOL_AGENT_REQUIRED')
  })

  it('rejects a stale agent object with the live agent id', async () => {
    const { ctx, agent } = await harness()
    const stale = stubAgent(String(agent.id), agent.session)
    const result = await execute(ctx, 'get_delivery_task', {}, stale)
    expect(result.error?.info?.code).toBe('DELIVERY_TOOL_AGENT_NOT_LIVE')
  })

  it('rejects a malformed task reference', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'ref' }, agent))
    const empty = await execute(ctx, 'record_change', { task_id: '', revision: 1, text: 'x' }, agent)
    expect(empty.error?.info?.code).toBe('DELIVERY_TOOL_INVALID_REF')
    const zero = await execute(ctx, 'record_change', { task_id: created['id'], revision: 0, text: 'x' }, agent)
    expect(zero.error?.info?.code).toBe('DELIVERY_TOOL_INVALID_REF')
  })

  it('blocks advancing when no task exists under stateful', async () => {
    const { ctx, agent } = await harness({ enforcement: 'stateful' })
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: 'missing', revision: 1, phase: 'implemented',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('resolves the direct-apply defaults before registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(DeliveryService)
    toolDelivery.apply(ctx, {})
    expect(ctx.tools.get('create_delivery_task')).toBeDefined()
  })
})

describe('tool-delivery design discipline', () => {
  it('records a design and advances an l1 task through designed', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 task', level: 'l1' }, agent))
    expect(created).toMatchObject({ level: 'l1', phase: 'created', designCount: 0 })
    const analyzed = resultTask(await execute(ctx, 'mark_analysis_done', {
      task_id: created['id'], revision: created['revision'],
    }, agent))
    expect(analyzed).toMatchObject({ analysisDone: true, revision: 2 })

    const designed = resultTask(await execute(ctx, 'record_design', {
      task_id: analyzed['id'],
      revision: analyzed['revision'],
      text: 'the design',
    }, agent))
    expect(designed).toMatchObject({ designCount: 1, revision: 3 })

    const advanced = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: designed['id'],
      revision: designed['revision'],
      phase: 'designed',
    }, agent))
    expect(advanced).toMatchObject({ phase: 'designed' })
  })

  it('blocks record_design before analysis is marked done under stateful', async () => {
    const { ctx, agent } = await harness({ enforcement: 'stateful' })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'analyze first', level: 'l1' }, agent))
    const result = await execute(ctx, 'record_design', {
      task_id: created['id'], revision: created['revision'], text: 'the design',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('allows record_design after analysis is marked done', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'analyze then design', level: 'l1' }, agent))
    const analyzed = resultTask(await execute(ctx, 'mark_analysis_done', {
      task_id: created['id'], revision: created['revision'],
    }, agent))
    const design = resultTask(await execute(ctx, 'record_design', {
      task_id: analyzed['id'], revision: analyzed['revision'], text: 'the design',
    }, agent))
    expect(design).toMatchObject({ designCount: 1 })
  })

  it('blocks record_spec design before analysis is marked done under stateful', async () => {
    const { ctx, agent } = await harness({ enforcement: 'stateful' })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'analyze first', level: 'l2' }, agent))
    const result = await execute(ctx, 'record_spec', {
      task_id: created['id'], revision: created['revision'],
      change_id: 'add-thing', kind: 'design', text: 'the design',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('allows record_spec design after analysis is marked done', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'analyze then spec', level: 'l2' }, agent))
    const analyzed = resultTask(await execute(ctx, 'mark_analysis_done', {
      task_id: created['id'], revision: created['revision'],
    }, agent))
    const spec = resultTask(await execute(ctx, 'record_spec', {
      task_id: analyzed['id'], revision: analyzed['revision'],
      change_id: 'add-thing', kind: 'design', text: 'the design',
    }, agent))
    expect(spec).toMatchObject({ specCount: 1 })
  })

  it('blocks advancing to designed without a design record under stateful', async () => {
    const { ctx, agent } = await harness({ enforcement: 'stateful' })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'gated', level: 'l1' }, agent))
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: created['id'],
      revision: created['revision'],
      phase: 'designed',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('grades an objective past the length floor to l2 without calling a model', async () => {
    const { ctx, agent } = await harness({}, {}, undefined, 'l0')
    const created = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: 'x'.repeat(201),
    }, agent))
    // The floor is deterministic and outranks any model reply, so the scripted
    // l0 must not be consulted at all.
    expect(created).toMatchObject({ level: 'l2' })
    expect(llmOf(ctx).requests).toHaveLength(0)
  })

  it('takes the tier the grading model names', async () => {
    const { ctx, agent } = await harness({}, {}, undefined, 'l1')
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'short' }, agent))
    expect(created).toMatchObject({ level: 'l1' })
    expect(llmOf(ctx).requests).toHaveLength(1)
  })

  it('keeps a short objective at l0 when the model says so', async () => {
    const { ctx, agent } = await harness({}, {}, undefined, 'l0')
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'short' }, agent))
    expect(created).toMatchObject({ level: 'l0' })
  })

  it('sends the configured grading prompt as the system message', async () => {
    const { ctx, agent } = await harness({ gradingPrompt: 'always answer l2' }, {}, undefined, 'l1')
    await execute(ctx, 'create_delivery_task', { objective: 'short' }, agent)
    // The rules are deployment text, so what the model receives has to be that
    // text and not a copy baked into the code.
    expect(llmOf(ctx).requests[0]?.system).toBe('always answer l2')
  })

  it('falls back to l1 when the grading response names no tier', async () => {
    const { ctx, agent } = await harness({}, {}, undefined, 'I cannot tell')
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'short' }, agent))
    // An unreadable answer must not release the request as a small fix.
    expect(created).toMatchObject({ level: 'l1' })
  })

  it('falls back to l1 when the grading call throws', async () => {
    const { ctx, agent } = await harness({}, {}, undefined, () => {
      throw new Error('provider down')
    })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'short' }, agent))
    expect(created).toMatchObject({ level: 'l1' })
  })

  it('accepts an explicit level override without grading', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'x', level: 'l1' }, agent))
    expect(created).toMatchObject({ level: 'l1' })
    expect(llmOf(ctx).requests).toHaveLength(0)
  })

  it('raises a graded tier with a todo_count estimate', async () => {
    const { ctx, agent } = await harness({ designThreshold: { todoCount: 5 } }, {}, undefined, 'l0')
    const created = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: 'short', todo_count: 6,
    }, agent))
    expect(created).toMatchObject({ level: 'l1' })
  })

  it('raises a graded tier with a touched_files estimate', async () => {
    const { ctx, agent } = await harness({ designThreshold: { touchedFiles: 3 } }, {}, undefined, 'l0')
    const created = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: 'short', touched_files: 4,
    }, agent))
    expect(created).toMatchObject({ level: 'l1' })
  })

  it('lets no estimate lower the tier the model named', async () => {
    const { ctx, agent } = await harness({ designThreshold: { todoCount: 50 } }, {}, undefined, 'l1')
    const created = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: 'short', todo_count: 1, touched_files: 0,
    }, agent))
    // Estimates may only raise: a small estimate is not evidence against a
    // model that judged the work to need a design.
    expect(created).toMatchObject({ level: 'l1' })
  })

  it('forces l2 for a non-small bug under requireOpenspecForBugs', async () => {
    const { ctx, agent } = await harness({ designThreshold: { todoCount: 2 } }, {}, undefined, 'l1')
    const created = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: 'a bug fix', is_bug: true, todo_count: 3,
    }, agent))
    expect(created).toMatchObject({ level: 'l2' })
  })

  it('does not force l2 for a bug when requireOpenspecForBugs is off', async () => {
    const { ctx, agent } = await harness(
      { designThreshold: { todoCount: 2 }, requireOpenspecForBugs: false }, {}, undefined, 'l1',
    )
    const created = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: 'a bug fix', is_bug: true, todo_count: 3,
    }, agent))
    expect(created).toMatchObject({ level: 'l1' })
  })
})

describe('tool-delivery spec discipline', () => {
  it('records a spec and advances an l2 task through specified', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l2 task', level: 'l2' }, agent))
    expect(created).toMatchObject({ level: 'l2', phase: 'created', specCount: 0 })
    const analyzed = resultTask(await execute(ctx, 'mark_analysis_done', {
      task_id: created['id'], revision: created['revision'],
    }, agent))

    const design = resultTask(await execute(ctx, 'record_design', {
      task_id: analyzed['id'], revision: analyzed['revision'], text: 'the design',
    }, agent))
    const designed = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: design['id'], revision: design['revision'], phase: 'designed',
    }, agent))
    expect(designed).toMatchObject({ phase: 'designed' })

    const spec = resultTask(await execute(ctx, 'record_spec', {
      task_id: designed['id'],
      revision: designed['revision'],
      change_id: 'add-thing',
      kind: 'spec',
      capability: 'thing',
      text: 'the spec',
    }, agent))
    expect(spec).toMatchObject({ specCount: 1, revision: 5 })

    const specified = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: spec['id'],
      revision: spec['revision'],
      phase: 'specified',
    }, agent))
    expect(specified).toMatchObject({ phase: 'specified' })
  })

  it('blocks advancing to specified without a spec record under stateful', async () => {
    const { ctx, agent } = await harness({ enforcement: 'stateful' })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'gated', level: 'l2' }, agent))
    const analyzed = resultTask(await execute(ctx, 'mark_analysis_done', {
      task_id: created['id'], revision: created['revision'],
    }, agent))
    const design = resultTask(await execute(ctx, 'record_design', {
      task_id: analyzed['id'], revision: analyzed['revision'], text: 'the design',
    }, agent))
    const designed = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: design['id'], revision: design['revision'], phase: 'designed',
    }, agent))
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: designed['id'],
      revision: designed['revision'],
      phase: 'specified',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('auto-tiers an objective past the openspec threshold to l2', async () => {
    const { ctx, agent } = await harness({ openspecThreshold: { descriptionChars: 12 } })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'a very long objective' }, agent))
    expect(created).toMatchObject({ level: 'l2' })
  })
})

describe('tool-delivery artifact persistence', () => {
  it('writes change records to .dsh/changes/<task-id>.md', async () => {
    const { ctx, agent, cwd } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'persist', level: 'l0' }, agent))
    const recorded = resultTask(await execute(ctx, 'record_change', {
      task_id: created['id'], revision: created['revision'], text: 'the change',
    }, agent))
    const path = join(cwd, '.dsh', 'changes', `${created['id']}.md`)
    expect(readFileSync(path, 'utf8')).toBe(`- [revision ${recorded['revision']}] the change\n`)
  })

  it('appends successive change records to the same file', async () => {
    const { ctx, agent, cwd } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'append', level: 'l0' }, agent))
    const first = resultTask(await execute(ctx, 'record_change', {
      task_id: created['id'], revision: created['revision'], text: 'first change',
    }, agent))
    await execute(ctx, 'record_change', {
      task_id: first['id'], revision: first['revision'], text: 'second change',
    }, agent)
    const content = readFileSync(join(cwd, '.dsh', 'changes', `${created['id']}.md`), 'utf8')
    expect(content).toContain('first change')
    expect(content).toContain('second change')
  })

  it('writes design records to .dsh/design/<task-id>.md', async () => {
    const { ctx, agent, cwd } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'persist design', level: 'l1' }, agent))
    const analyzed = resultTask(await execute(ctx, 'mark_analysis_done', {
      task_id: created['id'], revision: created['revision'],
    }, agent))
    await execute(ctx, 'record_design', {
      task_id: analyzed['id'], revision: analyzed['revision'], text: 'the design',
    }, agent)
    const path = join(cwd, '.dsh', 'design', `${created['id']}.md`)
    expect(readFileSync(path, 'utf8')).toContain('the design')
  })

  it('writes the design to .dsh/design and the spec to openspec/changes', async () => {
    const { ctx, agent, cwd } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'persist spec', level: 'l2' }, agent))
    const analyzed = resultTask(await execute(ctx, 'mark_analysis_done', {
      task_id: created['id'], revision: created['revision'],
    }, agent))
    const design = resultTask(await execute(ctx, 'record_design', {
      task_id: analyzed['id'], revision: analyzed['revision'], text: 'the design',
    }, agent))
    await execute(ctx, 'record_spec', {
      task_id: design['id'], revision: design['revision'],
      change_id: 'add-thing', kind: 'spec', capability: 'thing', text: 'the spec',
    }, agent)
    expect(readFileSync(join(cwd, '.dsh', 'design', `${created['id']}.md`), 'utf8')).toContain('the design')
    expect(readFileSync(join(cwd, 'openspec', 'changes', 'add-thing', 'specs', 'thing', 'spec.md'), 'utf8'))
      .toContain('the spec')
  })

  it('resolves artifact paths under the session cwd when set', async () => {
    const ctx = new Context()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-delivery-cwd-'))
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: mkdtempSync(join(tmpdir(), 'dsh-delivery-fs-')) })
    await ctx.plugin(StubShell)
    await ctx.plugin(StubLlm)
    await ctx.plugin(DeliveryService)
    await ctx.plugin(toolDelivery, {})
    const id = SessionId(`delivery-cwd-${Math.random()}`)
    const agent = stubAgent(`cwd-agent-${Math.random()}`, Session.create(
      id,
      undefined,
      { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd },
    ))
    ctx.agents.register(agent)
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'cwd persist' }, agent))
    await execute(ctx, 'record_change', {
      task_id: created['id'], revision: created['revision'], text: 'cwd change',
    }, agent)
    expect(readFileSync(join(cwd, '.dsh', 'changes', `${created['id']}.md`), 'utf8')).toContain('cwd change')
  })
})

describe('tool-delivery acceptance commands', () => {
  /**
   * Create an l0 task and walk it to implemented.
   *
   * The structural validation command runs at `verified`, so each case below
   * drives that transition and reads its outcome.
   */
  async function advanceToImplemented(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'acceptance', level: 'l0' }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    return task
  }

  /** Walk an l0 task to verified and report whether the transition was blocked. */
  async function advanceToVerified(
    ctx: Context,
    agent: Agent,
  ): Promise<{ task: Record<string, unknown>; blocked: boolean; error?: string }> {
    const implemented = await advanceToImplemented(ctx, agent)
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision: implemented['revision'], phase: 'verified',
    }, agent)
    if (result.isError) return { task: implemented, blocked: true, error: errorText(result) }
    return { task: resultTask(result), blocked: false }
  }

  /** The prompt-commands section these cases offer the acceptance gate. */
  const COMMANDS = [
    { name: 'smoke', prompt: 'Run the smoke suite and report every failure.' },
    { name: 'docs', prompt: 'Check the docs build without warnings.' },
  ]

  it('blocks verification until each configured command has a recorded run', async () => {
    const settings = new StubSettings({ verificationCommands: ['smoke'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['smoke'] }, {}, settings)
    const { blocked, error } = await advanceToVerified(ctx, agent)
    expect(blocked).toBe(true)
    // The gate names the command AND carries its prompt: deferContext is
    // dropped on a blocking throw, so the instruction must ride the message.
    expect(error).toContain('/smoke')
    expect(error).toContain('Run the smoke suite and report every failure.')
    expect(error).toContain('record_change')
  })

  it('allows verification once the command has a recorded run', async () => {
    const settings = new StubSettings({ verificationCommands: ['smoke'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['smoke'] }, {}, settings)
    const implemented = await advanceToImplemented(ctx, agent)
    await execute(ctx, 'record_change', {
      task_id: implemented['id'], revision: implemented['revision'],
      text: `${ACCEPTANCE_RECORD_PREFIX}smoke: suite passed`,
    }, agent)
    const current = await execute(ctx, 'get_delivery_task', {}, agent)
    const revision = resultTask(current)['revision']
    const verified = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision, phase: 'verified',
    }, agent)
    expect(verified.isError).toBe(false)
  })

  it('requires one record per command', async () => {
    const settings = new StubSettings({ verificationCommands: ['smoke', 'docs'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['smoke', 'docs'] }, {}, settings)
    const implemented = await advanceToImplemented(ctx, agent)
    await execute(ctx, 'record_change', {
      task_id: implemented['id'], revision: implemented['revision'],
      text: `${ACCEPTANCE_RECORD_PREFIX}smoke: suite passed`,
    }, agent)
    const current = await execute(ctx, 'get_delivery_task', {}, agent)
    const revision = resultTask(current)['revision']
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision, phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
    const message = errorText(result)
    expect(message).toContain('/docs')
    expect(message).not.toContain('/smoke:')
  })

  it('names only the next command and its position in the configured order', async () => {
    const settings = new StubSettings({ verificationCommands: ['smoke', 'docs'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['smoke', 'docs'] }, {}, settings)
    const implemented = await advanceToImplemented(ctx, agent)
    // Nothing recorded yet: the gate must ask for the first command only, so
    // the configured order is enforced rather than left to the model.
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision: implemented['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
    const message = errorText(result)
    expect(message).toContain('acceptance command 1 of 2')
    expect(message).toContain('/smoke')
    expect(message).not.toContain('/docs:')
  })

  it('holds the second command back until the first has a record', async () => {
    const settings = new StubSettings({ verificationCommands: ['smoke', 'docs'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['smoke', 'docs'] }, {}, settings)
    const implemented = await advanceToImplemented(ctx, agent)
    // Record only the SECOND command: the first still has no record, so the
    // gate keeps asking for it and advancing stays blocked.
    await execute(ctx, 'record_change', {
      task_id: implemented['id'], revision: implemented['revision'],
      text: `${ACCEPTANCE_RECORD_PREFIX}docs: checked the docs`,
    }, agent)
    const current = await execute(ctx, 'get_delivery_task', {}, agent)
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: resultTask(current)['id'], revision: resultTask(current)['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('/smoke')
  })

  it('advances through the configured order one command at a time', async () => {
    const settings = new StubSettings({ verificationCommands: ['smoke', 'docs'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['smoke', 'docs'] }, {}, settings)
    let task = await advanceToImplemented(ctx, agent)
    for (const name of ['smoke', 'docs']) {
      await execute(ctx, 'record_change', {
        task_id: task['id'], revision: task['revision'], text: `${ACCEPTANCE_RECORD_PREFIX}${name}: done`,
      }, agent)
      const current = await execute(ctx, 'get_delivery_task', {}, agent)
      task = resultTask(current)
    }
    const verified = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(verified.isError).toBe(false)
  })

  it('rejects a blank acceptance command name before registering anything', () => {
    const ctx = new Context()
    expect(() => { toolDelivery.apply(ctx, { verificationCommands: ['  '] }) }).toThrow(TypeError)
  })

  it('reports a selected command that no longer exists', async () => {
    const settings = new StubSettings({ verificationCommands: ['gone'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['gone'] }, {}, settings)
    const { blocked, error } = await advanceToVerified(ctx, agent)
    expect(blocked).toBe(true)
    expect(error).toContain('/gone')
    expect(error).toContain('no command with this name')
  })

  it('verifies freely when no acceptance command is configured', async () => {
    const { ctx, agent } = await harness()
    const { blocked } = await advanceToVerified(ctx, agent)
    expect(blocked).toBe(false)
  })

  it('accepts a non-l2 task whose checklist records an empty change id', async () => {
    const { ctx, agent } = await harness()
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 acceptance', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    // A non-l2 task has no OpenSpec change, so this is the empty id the
    // acceptance path used to interpolate into a target-less validate command.
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: '',
      items: [{ content: 'the fix', phase: 'implemented', status: 'completed' }],
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'verified' }, agent))

    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'accepted',
      coverage_confirmation: 'the design is implemented',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted' })
    // No validate command runs without a target: the empty id is a non-l2 task
    // having no OpenSpec change, not a target to validate.
    const commands = (ctx.get('shell') as StubShell).commands
    expect(commands.some(validatesNothing)).toBe(false)
  })

  it('validates the change id of an l2 task at acceptance', async () => {
    const { ctx, agent } = await harness()
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l2 acceptance', level: 'l2' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_spec', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing', kind: 'proposal', text: 'why',
    }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'specified' }, agent))
    // The validated id is the one the checklist recorded, so an l2 task must
    // record its checklist to own a validation target.
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: 'the fix', phase: 'implemented', status: 'completed' }],
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'verified' }, agent))

    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'accepted',
      coverage_confirmation: 'the design and spec are implemented',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted' })
    // An l2 task owns a change, so verification still validates that change.
    expect((ctx.get('shell') as StubShell).commands).toContain('openspec validate add-thing --strict --json')
  })

  it('blocks verification when the l2 structural validation fails', async () => {
    const { ctx, agent } = await harness({}, { exitCode: 1, stderr: { text: 'invalid change', truncated: false } })
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l2 structural', level: 'l2' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_spec', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing', kind: 'proposal', text: 'why',
    }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'specified' }, agent))
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: 'the fix', phase: 'implemented', status: 'completed' }],
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('openspec validate')
  })

  it('runs the structural validation in the session cwd', async () => {
    const ctx = new Context()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-delivery-ph-'))
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: mkdtempSync(join(tmpdir(), 'dsh-delivery-fs-')) })
    await ctx.plugin(StubShell)
    await ctx.plugin(StubLlm)
    await ctx.plugin(DeliveryService)
    await ctx.plugin(toolDelivery, {})
    const id = SessionId(`delivery-ph-${Math.random()}`)
    const agent = stubAgent(`ph-agent-${Math.random()}`, Session.create(
      id,
      undefined,
      { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd },
    ))
    ctx.agents.register(agent)
    const { task, blocked } = await advanceToVerified(ctx, agent)
    expect(blocked).toBe(false)
    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'accepted',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted' })
  })

  it('accepts a record whose name carries a slash or trailing colon', async () => {
    const settings = new StubSettings({ verificationCommands: ['smoke'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['smoke'] }, {}, settings)
    const implemented = await advanceToImplemented(ctx, agent)
    // 模型可能照抄界面上的 `/smoke:` 写法，因此解析接受这两种装饰。
    await execute(ctx, 'record_change', {
      task_id: implemented['id'], revision: implemented['revision'],
      text: `${ACCEPTANCE_RECORD_PREFIX}/smoke: 全部通过`,
    }, agent)
    const revision = resultTask(await execute(ctx, 'get_delivery_task', {}, agent))['revision']
    const verified = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision, phase: 'verified',
    }, agent)
    expect(verified.isError).toBe(false)
  })

  it('ignores an acceptance record the current task did not write', async () => {
    const settings = new StubSettings({ verificationCommands: ['smoke'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['smoke'] }, {}, settings)
    const implemented = await advanceToImplemented(ctx, agent)
    // 另一任务的记录不能替本任务放行：门禁按当前任务 id 过滤。
    await execute(ctx, 'record_change', {
      task_id: 'task-elsewhere', revision: 1,
      text: `${ACCEPTANCE_RECORD_PREFIX}smoke: 与他人无关`,
    }, agent)
    const revision = resultTask(await execute(ctx, 'get_delivery_task', {}, agent))['revision']
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision, phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('ignores a change record that is not an acceptance record', async () => {
    const settings = new StubSettings({ verificationCommands: ['smoke'] }, COMMANDS)
    const { ctx, agent } = await harness({ verificationCommands: ['smoke'] }, {}, settings)
    const implemented = await advanceToImplemented(ctx, agent)
    // 普通变更记录不得被读成验收记录，否则门禁形同虚设。
    await execute(ctx, 'record_change', {
      task_id: implemented['id'], revision: implemented['revision'],
      text: 'smoke: 这只是一条普通变更',
    }, agent)
    const revision = resultTask(await execute(ctx, 'get_delivery_task', {}, agent))['revision']
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision, phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('reports an empty configured prompt as such', async () => {
    // 命令存在但提示词为空时，门禁说明原因，而不是静默放宽要求。
    const settings = new StubSettings({ verificationCommands: ['smoke'] }, [{ name: 'smoke', prompt: '   ' }])
    const { ctx, agent } = await harness({ verificationCommands: ['smoke'] }, {}, settings)
    const { blocked, error } = await advanceToVerified(ctx, agent)
    expect(blocked).toBe(true)
    expect(error).toContain('its configured prompt is empty')
  })

  it('reports an unavailable settings provider by name', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: mkdtempSync(join(tmpdir(), 'dsh-delivery-ns-')) })
    await ctx.plugin(StubShell)
    await ctx.plugin(StubLlm)
    await ctx.plugin(DeliveryService)
    await ctx.plugin(toolDelivery, { verificationCommands: ['smoke'] })
    const agent = stubAgent(`ns-agent-${Math.random()}`)
    ctx.agents.register(agent)
    // 未挂载设置服务时无法读到提示词正文，门禁说明该原因而不是放行。
    const { blocked, error } = await advanceToVerified(ctx, agent)
    expect(blocked).toBe(true)
    expect(error).toContain('serves no settings provider')
  })
})

describe('tool-delivery acceptance commands over the real settings service', () => {
  /**
   * Compose the real settings provider and the real prompt-command plugin so
   * the cross-namespace read is exercised end to end: the hand-written stub
   * proves the gate's logic, not that a deployed composition wires it.
   */
  async function realHarness(promptCommands: readonly { name: string; prompt: string }[]) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: mkdtempSync(join(tmpdir(), 'delivery-real-')) })
    await ctx.plugin(StubShell)
    await ctx.plugin(StubLlm)
    await ctx.plugin(InMemorySettings, {})
    await ctx.plugin(CommandRegistry)
    await ctx.plugin(promptConfig, { commands: [...promptCommands] })
    await ctx.plugin(DeliveryService)
    await ctx.plugin(toolDelivery, { verificationCommands: promptCommands.map(command => command.name) })
    const agent = stubAgent(`real-${Math.random()}`)
    agent.options.provider = 'stub'
    agent.options.model = 'stub-grader'
    ctx.agents.register(agent)
    return { ctx, agent }
  }

  /** Walk an l0 task to implemented through the registered tools. */
  async function realToImplemented(ctx: Context, agent: Agent) {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'real', level: 'l0' }, agent))
    task = resultTask(await execute(ctx, 'record_change', {
      task_id: task['id'], revision: task['revision'], text: 'the fix',
    }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'implemented',
    }, agent))
    return task
  }

  it('carries the real prompt body into the gate message, then lets a record through', async () => {
    const { ctx, agent } = await realHarness([{ name: 'smoke', prompt: '运行冒烟测试并报告全部失败项' }])
    const task = await realToImplemented(ctx, agent)
    const blocked = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(blocked.isError).toBe(true)
    const message = errorText(blocked)
    // The body comes from the real prompt-commands section, not from a stub.
    expect(message).toContain('运行冒烟测试并报告全部失败项')
    expect(message).toContain('/smoke')

    const current = resultTask(await execute(ctx, 'get_delivery_task', {}, agent))
    await execute(ctx, 'record_change', {
      task_id: task['id'], revision: current['revision'],
      text: `${ACCEPTANCE_RECORD_PREFIX}smoke 全部通过`,
    }, agent)
    const revision = resultTask(await execute(ctx, 'get_delivery_task', {}, agent))['revision']
    const verified = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision, phase: 'verified',
    }, agent)
    expect(verified.isError).toBe(false)
  })

  it('reports a selected command the live plugin does not offer, and stays recoverable', async () => {
    // 选中的名字不在 prompt-commands 里时门禁照常阻止并说明该命令没有正文；
    // 模型记录该名字即可通过，因此任务不会不可挽回地卡住。
    const { ctx, agent } = await realHarness([])
    const task = await realToImplemented(ctx, agent)
    // 部署把验收命令配成一条提示词命令插件并未提供的名字。
    await ctx.get('settings')!.update('delivery', { verificationCommands: ['gone'] })
    const blocked = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(blocked.isError).toBe(true)
    expect(errorText(blocked)).toContain('/gone')
    expect(errorText(blocked)).toContain('no command with this name')

    const current = resultTask(await execute(ctx, 'get_delivery_task', {}, agent))
    await execute(ctx, 'record_change', {
      task_id: task['id'], revision: current['revision'],
      text: `${ACCEPTANCE_RECORD_PREFIX}gone 已核对`,
    }, agent)
    const revision = resultTask(await execute(ctx, 'get_delivery_task', {}, agent))['revision']
    const verified = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision, phase: 'verified',
    }, agent)
    expect(verified.isError).toBe(false)
  })

  it('changes gate behavior the moment the user saves a selection', async () => {
    // 用户改设置 → 门禁行为改变 的完整闭环：写入真实 settings 服务后立即生效。
    const { ctx, agent } = await realHarness([])
    const task = await realToImplemented(ctx, agent)
    const free = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(free.isError).toBe(false)

    const second = await realHarness([])
    const other = await realToImplemented(second.ctx, second.agent)
    await second.ctx.get('settings')!.update('delivery', { verificationCommands: ['smoke'] })
    const gated = await execute(second.ctx, 'advance_delivery_task', {
      task_id: other['id'], revision: other['revision'], phase: 'verified',
    }, second.agent)
    expect(gated.isError).toBe(true)
  })
})

describe('tool-delivery auto-detect', () => {
  // Only a graded l2 creates a task at pre-step; l0 and l1 both reach the
  // model, which decides whether the discipline applies.
  it('creates an l2 task at pre-step for a request above the character floor', async () => {
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'x'.repeat(400) }],
      source: { kind: 'user' },
    })])
    const view = ctx.delivery.get(agent)
    expect(view).toBeDefined()
    expect(view?.level).toBe('l2')
  })

  it('creates an l0 task for a short request so the discipline covers it', async () => {
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'fix the typo' }],
      source: { kind: 'user' },
    })])
    const view = ctx.delivery.get(agent)
    expect(view?.level).toBe('l0')
  })

  it('replaces an unfinished l0 task with the next request', async () => {
    // An l0 task the model never advances must not reject later requests:
    // `create` refuses a new task while a non-accepted one is current and no
    // tool clears a task, so the replacement is what keeps the session usable.
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'fix the typo' }],
      source: { kind: 'user' },
    })])
    const first = ctx.delivery.get(agent)
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'fix another typo' }],
      source: { kind: 'user' },
    })])
    const second = ctx.delivery.get(agent)
    expect(second?.id).not.toBe(first?.id)
    expect(second?.objective).toBe('fix another typo')
  })

  it('does not create a second task when one already exists', async () => {
    const { ctx, agent } = await harness()
    const existing = ctx.delivery.create(agent, { objective: 'existing task', level: 'l1' })
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'x'.repeat(400) }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)?.id).toBe(existing.id)
  })

  it('ignores messages that are not a direct human request', async () => {
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'x'.repeat(400) }],
      source: { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'test notice' },
    })])
    expect(ctx.delivery.get(agent)).toBeUndefined()
  })

  it('does not auto-create when autoDetect is disabled', async () => {
    const { ctx, agent } = await harness({ autoDetect: false })
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'x'.repeat(400) }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)).toBeUndefined()
  })

  const MULTI_PART_REQUEST = '“设置”中 MCP 页面配置服务细节优化：\n'
    + '1、去掉底部的“添加服务器”按钮；\n'
    + '2、进入页面时全部启动的 MCP 服务要自动连接；\n'
    + '3、点击“编辑”时针对 mcp.json 编辑而不是 settings.yml；\n'
    + '4、点击“配置 MCP”时在当前页面弹出 mcp.json 编辑页并支持高亮；\n'
    + '5、编辑后配置要立即生效。'

  it('takes the tier the model names for a multi-part request', async () => {
    // The list's shape no longer decides the tier: the grading call reads the
    // request and answers. The task is still created automatically, so the
    // request never runs without a progress surface.
    const { ctx, agent } = await harness({}, {}, undefined, 'l1')
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: MULTI_PART_REQUEST }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)?.level).toBe('l1')
    // The model sees the request text itself, which is what makes a semantic
    // judgement possible at all.
    const sent = llmOf(ctx).requests[0]?.messages[0]
    expect(JSON.stringify(sent)).toContain('MCP')
  })

  it('sends the request text rather than a keyword verdict', async () => {
    const { ctx, agent } = await harness({}, {}, undefined, 'l0')
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: '重构这个模块的内部实现' }],
      source: { kind: 'user' },
    })])
    const request = llmOf(ctx).requests[0]
    expect(request?.system).toContain('l0')
    const text = JSON.stringify(request?.messages)
    // The words that used to decide the tier now only travel as content.
    expect(text).toContain('重构这个模块的内部实现')
    expect(request?.maxTokens).toBeLessThan(64)
  })

  it('records the grading evidence in the change artifact', async () => {
    const { ctx, agent, cwd } = await harness({}, {}, undefined, 'l1')
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'short' }, agent))
    // A reader who disagrees with the tier must be able to see what decided it.
    const artifact = readFileSync(join(cwd, '.dsh', 'changes', `${created['id']}.md`), 'utf8')
    expect(artifact).toContain('graded l1 by model')
  })

  it('records a fallback grade as such', async () => {
    const { ctx, agent, cwd } = await harness({}, {}, undefined, 'no idea')
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'short' }, agent))
    const artifact = readFileSync(join(cwd, '.dsh', 'changes', `${created['id']}.md`), 'utf8')
    expect(artifact).toContain('graded l1 by fallback')
  })

  it('does not grade again while an l1 task holds the session', async () => {
    // An l1/l2 task keeps its claim, so a later direct request must not spend
    // another grading call or replace the task.
    const { ctx, agent } = await harness({}, {}, undefined, 'l1')
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    })])
    const first = ctx.delivery.get(agent)
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'second' }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)?.id).toBe(first?.id)
    expect(llmOf(ctx).requests).toHaveLength(1)
  })
})

describe('tool-delivery openspec change layout', () => {
  /** Create an l2 task and return its first ref. */
  async function l2Task(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    return resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l2 task', level: 'l2' }, agent))
  }

  it('writes each of the three non-delta artifacts to its own path', async () => {
    const { ctx, agent, cwd } = await harness()
    const created = await l2Task(ctx, agent)
    const analyzed = resultTask(await execute(ctx, 'mark_analysis_done', {
      task_id: created['id'], revision: created['revision'],
    }, agent))
    let revision = analyzed['revision']
    for (const kind of ['proposal', 'design', 'tasks'] as const) {
      const after = resultTask(await execute(ctx, 'record_spec', {
        task_id: analyzed['id'], revision, change_id: 'add-thing', kind, text: `the ${kind}`,
      }, agent))
      revision = after['revision']
      expect(readFileSync(join(cwd, 'openspec', 'changes', 'add-thing', `${kind}.md`), 'utf8'))
        .toBe(`the ${kind}`)
    }
  })

  it('writes tasks.md without a revision prefix so OpenSpec can parse it', async () => {
    const { ctx, agent, cwd } = await harness()
    const created = await l2Task(ctx, agent)
    await execute(ctx, 'record_spec', {
      task_id: created['id'], revision: created['revision'], change_id: 'add-thing', kind: 'tasks',
      text: '- [ ] 1.1 do the thing\n',
    }, agent)
    expect(readFileSync(join(cwd, 'openspec', 'changes', 'add-thing', 'tasks.md'), 'utf8'))
      .toBe('- [ ] 1.1 do the thing\n')
  })

  it('rejects a change id that is not verb-led kebab-case', async () => {
    const { ctx, agent } = await harness()
    const created = await l2Task(ctx, agent)
    const result = await execute(ctx, 'record_spec', {
      task_id: created['id'], revision: created['revision'], change_id: 'task-3cc0ca7f', kind: 'proposal', text: 'x',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('rejects a spec delta without a kebab-case capability', async () => {
    const { ctx, agent } = await harness()
    const created = await l2Task(ctx, agent)
    const result = await execute(ctx, 'record_spec', {
      task_id: created['id'], revision: created['revision'], change_id: 'add-thing', kind: 'spec', text: 'x',
    }, agent)
    expect(result.isError).toBe(true)
  })
})

describe('tool-delivery l2 task source', () => {
  /** Register a stand-in for the lightweight todo list this gate refuses. */
  function registerTodo(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'todo_write',
      description: 'stub todo list used to prove the l2 gate',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
      },
      execute: () => Promise.resolve('ok'),
    }))
  }

  it('denies todo_write while the current task is l2', async () => {
    const { ctx, agent } = await harness()
    registerTodo(ctx)
    await execute(ctx, 'create_delivery_task', { objective: 'l2 task', level: 'l2' }, agent)
    expect((await execute(ctx, 'todo_write', {}, agent)).isError).toBe(true)
  })

  it('allows todo_write for an l1 task', async () => {
    const { ctx, agent } = await harness()
    registerTodo(ctx)
    await execute(ctx, 'create_delivery_task', { objective: 'l1 task', level: 'l1' }, agent)
    expect((await execute(ctx, 'todo_write', {}, agent)).isError).toBe(false)
  })
})

/** Walk an l2 task through designed into specified. */
async function toSpecified(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
  let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l2 task', level: 'l2' }, agent))
  task = resultTask(await execute(ctx, 'mark_analysis_done', {
    task_id: task['id'], revision: task['revision'],
  }, agent))
  task = resultTask(await execute(ctx, 'record_design', {
    task_id: task['id'], revision: task['revision'], text: 'the design',
  }, agent))
  task = resultTask(await execute(ctx, 'advance_delivery_task', {
    task_id: task['id'], revision: task['revision'], phase: 'designed',
  }, agent))
  task = resultTask(await execute(ctx, 'record_spec', {
    task_id: task['id'], revision: task['revision'], change_id: 'add-thing', kind: 'proposal', text: 'why',
  }, agent))
  return resultTask(await execute(ctx, 'advance_delivery_task', {
    task_id: task['id'], revision: task['revision'], phase: 'specified',
  }, agent))
}

describe('tool-delivery corrected annotations', () => {
  it('lets a task pass verification after the model corrects its covers list', async () => {
    // The scenario check reads the disk tasks.md, so a corrected annotation has
    // to reach that file. When rendering preserved the old annotation, a task
    // that fixed its checklist was still blocked forever — the correction was
    // simply unrepresentable.
    const { ctx, agent, cwd } = await harness()
    const task = await toSpecified(ctx, agent)
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(join(dir, 'specs', 'demo'), { recursive: true })
    writeFileSync(join(dir, 'design.md'), '### D1 做它\n')
    writeFileSync(join(dir, 'specs', 'demo', 'spec.md'), '#### Scenario: 它要工作\n')

    // The first checklist misses the scenario key, so verification blocks.
    let current = resultTask(await execute(ctx, 'record_spec', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing', kind: 'tasks',
      text: '- [x] 做它 (covers: design/D1)\n',
    }, agent))
    current = resultTask(await execute(ctx, 'record_tasks', {
      task_id: current['id'], revision: current['revision'], change_id: 'add-thing',
      items: [{ content: '做它 (covers: design/D1)', phase: 'implemented', status: 'completed' }],
    }, agent))
    current = resultTask(await execute(ctx, 'record_change', {
      task_id: current['id'], revision: current['revision'], text: 'the fix',
    }, agent))
    current = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: current['id'], revision: current['revision'], phase: 'implemented',
    }, agent))
    const blocked = await execute(ctx, 'advance_delivery_task', {
      task_id: current['id'], revision: current['revision'], phase: 'verified',
    }, agent)
    expect(blocked.isError).toBe(true)

    // Correcting the annotation writes it through to the disk checklist.
    current = resultTask(await execute(ctx, 'record_tasks', {
      task_id: current['id'], revision: current['revision'], change_id: 'add-thing',
      items: [{ content: '做它 (covers: demo/它要工作, design/D1)', phase: 'implemented', status: 'completed' }],
    }, agent))
    expect(readFileSync(join(dir, 'tasks.md'), 'utf8'))
      .toBe('- [x] 做它 (covers: demo/它要工作, design/D1)\n')

    const verified = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: current['id'], revision: current['revision'], phase: 'verified',
    }, agent))
    expect(verified).toMatchObject({ phase: 'verified' })
  })
})

describe('tool-delivery checklist cross-check', () => {

  /**
   * Record the change and return the ref that follows it. A change record is a
   * gate of its own, so these cases must satisfy it to reach the cross-check.
   */
  async function withChange(
    ctx: Context,
    agent: Agent,
    task: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return resultTask(await execute(ctx, 'record_change', {
      task_id: task['id'], revision: task['revision'], text: 'the fix',
    }, agent))
  }

  it('rejects implementing when an out-of-band edit desynchronizes tasks.md', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await toSpecified(ctx, agent)
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.md'), '- [ ] 1.1 build it\n')
    // `record_tasks` keeps the disk in sync with the recorded checklist; the
    // gate's defense-in-depth job is to catch a later out-of-band edit that
    // makes disk and record disagree.
    const after = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: '1.1 build it', phase: 'implemented', status: 'completed' }],
    }, agent))
    writeFileSync(join(dir, 'tasks.md'), '- [ ] 1.1 build it\n')
    const changed = await withChange(ctx, agent, after)
    const blocked = await execute(ctx, 'advance_delivery_task', {
      task_id: changed['id'], revision: changed['revision'], phase: 'implemented',
    }, agent)
    expect(blocked.isError).toBe(true)
  })

  it('allows implementing once tasks.md and the recorded checklist agree', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await toSpecified(ctx, agent)
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.md'), '- [x] 1.1 build it\n')
    // The recorded item content must match the line on disk once `record_tasks`
    // keeps `tasks.md` in sync; the count-only check used to be loose enough
    // to forgive a mismatch, but the synced file makes content the authority.
    const after = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: '1.1 build it', phase: 'implemented', status: 'completed' }],
    }, agent))
    const changed = await withChange(ctx, agent, after)
    const advanced = await execute(ctx, 'advance_delivery_task', {
      task_id: changed['id'], revision: changed['revision'], phase: 'implemented',
    }, agent)
    expect(advanced.isError).toBe(false)
  })

  it('reports a content drift when tasks.md gains an unmatched checkbox line', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await toSpecified(ctx, agent)
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.md'), '- [ ] 1.1 build it\n')
    const after = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: '1.1 build it', phase: 'implemented', status: 'completed' }],
    }, agent))
    // An out-of-band line addition makes disk.total diverge from reported.total.
    writeFileSync(join(dir, 'tasks.md'), '- [x] 1.1 build it\n- [ ] extra line\n')
    const changed = await withChange(ctx, agent, after)
    const blocked = await execute(ctx, 'advance_delivery_task', {
      task_id: changed['id'], revision: changed['revision'], phase: 'implemented',
    }, agent)
    expect(blocked.isError).toBe(true)
    const block = blocked.content[0]
    expect(block?.type).toBe('text')
    if (block?.type === 'text') expect(block.text).toContain('contents drifted')
  })

  it('reports a status desync when only the checkbox state drifts', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await toSpecified(ctx, agent)
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.md'), '- [ ] 1.1 build it\n')
    const after = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: '1.1 build it', phase: 'implemented', status: 'completed' }],
    }, agent))
    // An out-of-band checkbox flip keeps total equal but changes done.
    writeFileSync(join(dir, 'tasks.md'), '- [ ] 1.1 build it\n')
    const changed = await withChange(ctx, agent, after)
    const blocked = await execute(ctx, 'advance_delivery_task', {
      task_id: changed['id'], revision: changed['revision'], phase: 'implemented',
    }, agent)
    expect(blocked.isError).toBe(true)
    const block = blocked.content[0]
    expect(block?.type).toBe('text')
    if (block?.type === 'text') expect(block.text).toContain('re-record record_tasks')
  })
})

describe('tool-delivery task checklist', () => {
  /** Create an l2 task and return its ref fields. */
  async function l2(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    return resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l2 task', level: 'l2' }, agent))
  }

  /** Read the `delivery-tasks` projection value for the agent's session. */
  function checklist(ctx: Context, agent: Agent): {
    changeId: string
    progress: Record<string, { done: number; total: number }>
  } {
    return ctx.sessionProjections.snapshot(agent.session).values['delivery-tasks'] as never
  }

  it('records a checklist and exposes per-phase progress', async () => {
    const { ctx, agent } = await harness()
    const created = await l2(ctx, agent)
    await execute(ctx, 'record_tasks', {
      task_id: created['id'], revision: created['revision'], change_id: 'add-thing',
      items: [
        { content: 'build it', phase: 'implemented', status: 'pending' },
        { content: 'test it', phase: 'verified', status: 'completed' },
      ],
    }, agent)
    const view = checklist(ctx, agent)
    expect(view.changeId).toBe('add-thing')
    expect(view.progress.implemented).toEqual({ done: 0, total: 1 })
    expect(view.progress.verified).toEqual({ done: 1, total: 1 })
  })

  it('records an empty change_id for a non-l2 task', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 task', level: 'l1' }, agent))
    await execute(ctx, 'record_tasks', {
      task_id: created['id'], revision: created['revision'], change_id: '',
      items: [{ content: 'build it', phase: 'implemented', status: 'pending' }],
    }, agent)
    expect(checklist(ctx, agent).changeId).toBe('')
  })

  it('rejects a checklist item whose phase is unknown', async () => {
    const { ctx, agent } = await harness()
    const created = await l2(ctx, agent)
    const result = await execute(ctx, 'record_tasks', {
      task_id: created['id'], revision: created['revision'], change_id: 'add-thing',
      items: [{ content: 'x', phase: 'nope', status: 'pending' }],
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('rejects a change id that is not verb-led kebab-case', async () => {
    const { ctx, agent } = await harness()
    const created = await l2(ctx, agent)
    const result = await execute(ctx, 'record_tasks', {
      task_id: created['id'], revision: created['revision'], change_id: 'x; rm -rf /',
      items: [{ content: 'x', phase: 'implemented', status: 'pending' }],
    }, agent)
    expect(result.isError).toBe(true)
  })
})

describe('tool-delivery non-l2 verification', () => {
  /** Walk an l1 task to implemented with a recorded checklist. */
  async function l1ToImplemented(
    ctx: Context,
    agent: Agent,
    status: string,
  ): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 task', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: '',
      items: [{ content: 'build it', phase: 'implemented', status }],
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    return resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'implemented',
    }, agent))
  }

  it('blocks verifying a non-l2 task with an unfinished checklist under stateful', async () => {
    const { ctx, agent } = await harness({ enforcement: 'stateful' })
    const implemented = await l1ToImplemented(ctx, agent, 'pending')
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision: implemented['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('verifies a non-l2 task once its checklist is complete', async () => {
    const { ctx, agent } = await harness()
    const implemented = await l1ToImplemented(ctx, agent, 'completed')
    const verified = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision: implemented['revision'], phase: 'verified',
    }, agent))
    expect(verified).toMatchObject({ phase: 'verified' })
  })

  it('blocks verifying a non-l2 task with a non-empty change_id and unfinished checklist', async () => {
    const { ctx, agent } = await harness({ enforcement: 'stateful' })
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 task', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    // A non-l2 task with a non-empty change_id still verifies by its level.
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: 'build it', phase: 'implemented', status: 'pending' }],
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
  })
})

describe('tool-delivery coverage review', () => {
  /** A stubbed `openspec show --json` result naming one capability. */
  const SHOW = { stdout: { text: '{"deltas":[{"spec":"cap"}]}', truncated: false } }

  /** Write a change declaring two scenarios and one design decision. */
  function writeChange(cwd: string, tasks: string): void {
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(join(dir, 'specs', 'cap'), { recursive: true })
    writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), [
      '## ADDED Requirements',
      '### Requirement: 覆盖检查',
      '#### Scenario: 已覆盖的场景',
      '#### Scenario: 未覆盖的场景',
    ].join('\n'))
    writeFileSync(join(dir, 'design.md'), '## D1 决策\n')
    writeFileSync(join(dir, 'tasks.md'), tasks)
  }

  /** Reach implemented with a checklist that agrees with tasks.md. */
  async function toImplemented(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    const task = await toSpecified(ctx, agent)
    const after = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: '1.1 已覆盖的场景', phase: 'implemented', status: 'completed' }],
    }, agent))
    const changed = resultTask(await execute(ctx, 'record_change', {
      task_id: after['id'], revision: after['revision'], text: 'the fix',
    }, agent))
    return resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: changed['id'], revision: changed['revision'], phase: 'implemented',
    }, agent))
  }

  /** A checklist that claims one scenario and leaves the other unclaimed. */
  const PARTIAL = '- [x] 1.1 已覆盖的场景 (covers: cap/已覆盖的场景)\n'

  it('blocks verifying while a declared scenario has no checklist item', async () => {
    const { ctx, agent, cwd } = await harness({}, SHOW)
    writeChange(cwd, PARTIAL)
    const implemented = await toImplemented(ctx, agent)
    const blocked = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision: implemented['revision'], phase: 'verified',
    }, agent)
    expect(blocked.isError).toBe(true)
  })

  it('releases the gap when the model confirms it specifically', async () => {
    const { ctx, agent, cwd } = await harness({}, SHOW)
    writeChange(cwd, PARTIAL)
    const implemented = await toImplemented(ctx, agent)
    const allowed = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision: implemented['revision'], phase: 'verified',
      coverage_confirmation: '未覆盖的场景 ships inside the same grading.ts change and needs no separate task',
    }, agent)
    expect(allowed.isError).toBe(false)
  })

  it('rejects a bare confirmation that only says done', async () => {
    const { ctx, agent, cwd } = await harness({}, SHOW)
    writeChange(cwd, PARTIAL)
    const implemented = await toImplemented(ctx, agent)
    const blocked = await execute(ctx, 'advance_delivery_task', {
      task_id: implemented['id'], revision: implemented['revision'], phase: 'verified',
      coverage_confirmation: 'done',
    }, agent)
    expect(blocked.isError).toBe(true)
  })
})

describe('tool-delivery settings wiring', () => {
  it('grades with the settings-resolved length floor when a provider is mounted', async () => {
    // The floor is a settings field, so a user section has to move it: at 20
    // the 25-character request is over the floor and grades l2 with no call.
    const { ctx, agent } = await harness({}, {}, new StubSettings({
      openspecThreshold: { todoCount: 15, descriptionChars: 20 },
    }), 'l0')
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'a'.repeat(25) }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)?.level).toBe('l2')
    expect(llmOf(ctx).requests).toHaveLength(0)
  })

  it('uses the settings-resolved grading prompt', async () => {
    // The rules are user-editable text, so the call must carry the resolved
    // section rather than the composition default.
    const { ctx, agent } = await harness({}, {}, new StubSettings({
      gradingPrompt: 'always answer l1',
    }), 'l0')
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'short' }],
      source: { kind: 'user' },
    })])
    expect(llmOf(ctx).requests[0]?.system).toBe('always answer l1')
  })

  it('keeps the composition policy when no provider is mounted', async () => {
    const { ctx, agent } = await harness({}, {}, undefined, 'l0')
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'a'.repeat(25) }],
      source: { kind: 'user' },
    })])
    // 25 characters is under the 200-character floor, so the model decides.
    expect(ctx.delivery.get(agent)?.level).toBe('l0')
  })

  it('lets a gate through when the settings resolve enforcement to off', async () => {
    // Composition is stateful, the user section says off: the decision point
    // must honour the user section even though the tools were registered at
    // load under stateful. Without a per-decision read the loaded policy would
    // keep blocking a gate the user already turned off.
    const { ctx, agent } = await harness({ enforcement: 'stateful' }, {}, new StubSettings({
      enforcement: 'off',
    }))
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'gate it', level: 'l0' }, agent))
    // No record_change: under stateful this is exactly the blocked transition.
    task = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'implemented',
    }, agent))
    expect(task).toMatchObject({ phase: 'implemented' })
  })
})

describe('tool-delivery verification inputs', () => {
  /**
   * Walk an l1 task to implemented, leaving the verified transition to the case.
   *
   * The checklist content is supplied so each case can choose what its items
   * claim to cover.
   */
  async function l1ReadyToVerify(
    ctx: Context,
    agent: Agent,
    objective: string,
    designText: string,
    items: readonly { content: string; phase: string; status: string }[],
  ): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective, level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: designText }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: '', items,
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    return task
  }

  it('verifies an l1 task whose items cover every request item and design decision', async () => {
    const { ctx, agent } = await harness()
    const task = await l1ReadyToVerify(
      ctx,
      agent,
      '1、做甲\n2、做乙',
      '### D1 先做甲\n### D2 再做乙\n',
      [
        { content: '做甲 (covers: req/1, design/D1)', phase: 'implemented', status: 'completed' },
        { content: '做乙 (covers: req/2, design/D2)', phase: 'implemented', status: 'completed' },
      ],
    )
    const verified = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent))
    expect(verified).toMatchObject({ phase: 'verified' })
  })

  it('blocks verification when a numbered request item is not covered', async () => {
    const { ctx, agent } = await harness()
    const task = await l1ReadyToVerify(
      ctx,
      agent,
      '1、做甲\n2、做乙',
      '### D1 先做甲\n',
      [
        { content: '做甲 (covers: req/1, design/D1)', phase: 'implemented', status: 'completed' },
      ],
    )
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('req/2')
  })

  it('blocks verification when a design decision is not covered', async () => {
    const { ctx, agent } = await harness()
    const task = await l1ReadyToVerify(
      ctx,
      agent,
      '做甲',
      '### D1 先做甲\n### D2 再做乙\n',
      [{ content: '做甲 (covers: design/D1)', phase: 'implemented', status: 'completed' }],
    )
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('design/D2')
  })

  it('does not count an unfinished item as covering its point', async () => {
    const { ctx, agent } = await harness()
    const task = await l1ReadyToVerify(
      ctx,
      agent,
      '1、做甲',
      '### D1 先做甲\n',
      [
        { content: '做甲 (covers: req/1, design/D1)', phase: 'implemented', status: 'in_progress' },
      ],
    )
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    // The unfinished item is reported first as an unfinished checklist item.
    expect(result.isError).toBe(true)
  })

  it('verifies an l0 task that covers its request without a checklist', async () => {
    // l0 owes no checklist, so its request is the only verification input.
    const { ctx, agent } = await harness()
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: '修复拼写', level: 'l0' }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    const verified = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent))
    expect(verified).toMatchObject({ phase: 'verified' })
  })

  it('releases an uncovered point only through a specific confirmation', async () => {
    const { ctx, agent } = await harness()
    const task = await l1ReadyToVerify(
      ctx,
      agent,
      '1、做甲',
      '### D1 先做甲\n',
      [{ content: '做甲', phase: 'implemented', status: 'completed' }],
    )
    // A bare "done" is below the specificity floor and stays blocked.
    const bare = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
      coverage_confirmation: 'done',
    }, agent)
    expect(bare.isError).toBe(true)
    const specific = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
      coverage_confirmation: 'req/1 与 design/D1 已由该项实现并验证通过',
    }, agent))
    expect(specific).toMatchObject({ phase: 'verified' })
  })
})

describe('tool-delivery acceptance gate', () => {
  /** Walk an l0 task to verified. */
  async function advanceL0ToVerified(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l0 task', level: 'l0' }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'verified' }, agent))
    return task
  }

  /** Walk an l1 task (with a design record and a completed checklist) to verified. */
  async function advanceL1ToVerified(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 task', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: '',
      items: [{ content: 'the fix', phase: 'implemented', status: 'completed' }],
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'verified' }, agent))
    return task
  }

  it('blocks verifying an l1 task that recorded no checklist', async () => {
    // An l1 task owes a checklist; the previous gate returned early when none
    // was recorded, so the task verified without any evidence of the work.
    const { ctx, agent } = await harness()
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 task', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('blocks verifying an l1 task whose checklist still has unfinished items', async () => {
    const { ctx, agent } = await harness()
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 task', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: '',
      items: [{ content: 'the fix', phase: 'implemented', status: 'in_progress' }],
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('accepts an l0 task without coverage confirmation', async () => {
    const { ctx, agent } = await harness()
    const verified = await advanceL0ToVerified(ctx, agent)
    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted' })
  })

  it('blocks accepting an l1 task without coverage confirmation under stateful', async () => {
    const { ctx, agent } = await harness()
    const verified = await advanceL1ToVerified(ctx, agent)
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('accepts an l1 task with coverage confirmation and records it', async () => {
    const { ctx, agent } = await harness()
    const verified = await advanceL1ToVerified(ctx, agent)
    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
      coverage_confirmation: 'the design is implemented',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted', changeCount: 2 })
  })

  it('accepts an l1 task without coverage confirmation under advisory', async () => {
    const { ctx, agent } = await harness({ enforcement: 'advisory' })
    const verified = await advanceL1ToVerified(ctx, agent)
    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted' })
  })

  it('auto-records a change when accepting a task with no change record under advisory', async () => {
    const { ctx, agent } = await harness({ enforcement: 'advisory' })
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'no change', level: 'l0' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'verified' }, agent))
    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'accepted',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted', changeCount: 1 })
  })
})

describe('renderTasksMarkdown', () => {
  it('writes a corrected annotation through to the disk line', () => {
    // The scenario and design checks read this file, so a model that fixes its
    // `covers:` list must be able to make that correction reach the disk.
    // Rewriting only the checkbox left the old annotation in place forever.
    const rendered = renderTasksMarkdown(
      '- [ ] ship it (covers: design/D1)\n',
      [{ content: 'ship it (covers: cap/scenario, design/D1)', phase: 'implemented', status: 'completed' }],
    )
    expect(rendered).toBe('- [x] ship it (covers: cap/scenario, design/D1)\n')
  })

  it('updates the checkbox of a matching line and preserves a covers annotation', () => {
    const rendered = renderTasksMarkdown(
      '- [ ] ship it (covers: cap/a, cap/b)\n',
      [{ content: 'ship it', phase: 'implemented', status: 'completed' }],
    )
    expect(rendered).toBe('- [x] ship it (covers: cap/a, cap/b)\n')
  })

  it('writes a pending checkbox for in_progress without flipping done', () => {
    const rendered = renderTasksMarkdown(
      '- [ ] build it\n',
      [{ content: 'build it', phase: 'implemented', status: 'in_progress' }],
    )
    expect(rendered).toBe('- [ ] build it\n')
  })

  it('appends an item whose content has no matching line', () => {
    const rendered = renderTasksMarkdown(
      '- [ ] ship it (covers: cap/a)\n',
      [
        { content: 'ship it', phase: 'implemented', status: 'completed' },
        { content: 'verify it', phase: 'verified', status: 'pending' },
      ],
    )
    expect(rendered).toBe('- [x] ship it (covers: cap/a)\n- [ ] verify it\n')
  })

  it('preserves unrelated lines such as headings and blank lines', () => {
    const rendered = renderTasksMarkdown(
      '## 1. Setup\n\n- [ ] ship it\n\n## 2. Done\n',
      [{ content: 'ship it', phase: 'implemented', status: 'completed' }],
    )
    expect(rendered).toBe('## 1. Setup\n\n- [x] ship it\n\n## 2. Done\n')
  })

  it('returns only the appended items when the existing body is empty', () => {
    const rendered = renderTasksMarkdown(
      '',
      [
        { content: 'a', phase: 'implemented', status: 'pending' },
        { content: 'b', phase: 'verified', status: 'completed' },
      ],
    )
    expect(rendered).toBe('- [ ] a\n- [x] b\n')
  })

  it('consumes a content once so duplicates do not collapse onto the same line', () => {
    const rendered = renderTasksMarkdown(
      '- [ ] ship it\n- [ ] ship it\n',
      [
        { content: 'ship it', phase: 'implemented', status: 'completed' },
        { content: 'ship it', phase: 'verified', status: 'pending' },
      ],
    )
    expect(rendered).toBe('- [x] ship it\n- [ ] ship it\n')
  })
})

describe('orderItemsByMarkdown', () => {
  it('returns items unchanged when the existing body is empty', () => {
    const ordered = orderItemsByMarkdown('', [
      { content: 'a', phase: 'implemented', status: 'pending' },
      { content: 'b', phase: 'verified', status: 'completed' },
    ])
    expect(ordered.map(item => item.content)).toEqual(['a', 'b'])
  })

  it('orders items to match the existing tasks.md line order', () => {
    const ordered = orderItemsByMarkdown(
      '- [ ] build first\n- [ ] verify it\n- [ ] ship it\n',
      [
        { content: 'ship it', phase: 'implemented', status: 'pending' },
        { content: 'build first', phase: 'implemented', status: 'completed' },
        { content: 'verify it', phase: 'verified', status: 'in_progress' },
      ],
    )
    expect(ordered.map(item => item.content)).toEqual(['build first', 'verify it', 'ship it'])
  })

  it('appends items absent from the existing tasks.md after matched lines', () => {
    const ordered = orderItemsByMarkdown(
      '- [ ] build first\n',
      [
        { content: 'ship it', phase: 'implemented', status: 'pending' },
        { content: 'build first', phase: 'implemented', status: 'completed' },
        { content: 'verify it', phase: 'verified', status: 'pending' },
      ],
    )
    expect(ordered.map(item => item.content)).toEqual(['build first', 'ship it', 'verify it'])
  })

  it('strips a covers annotation before matching a line in the body', () => {
    const ordered = orderItemsByMarkdown(
      '- [ ] build first (covers: cap/scenario)\n',
      [
        { content: 'build first', phase: 'implemented', status: 'pending' },
      ],
    )
    expect(ordered.map(item => item.content)).toEqual(['build first'])
  })

  it('preserves the input order when no item content matches the body', () => {
    const ordered = orderItemsByMarkdown(
      '- [ ] unrelated (covers: cap/a)\n',
      [
        { content: 'ship it', phase: 'implemented', status: 'pending' },
        { content: 'verify it', phase: 'verified', status: 'pending' },
      ],
    )
    expect(ordered.map(item => item.content)).toEqual(['ship it', 'verify it'])
  })
})

describe('tool-delivery task checklist disk sync', () => {
  /** Walk an l2 task to the specified phase so record_tasks can write a tasks.md. */
  async function l2Task(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l2 sync', level: 'l2' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    return resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
  }

  /** Read the `delivery-tasks` projection value for the agent's session. */
  function tasksView(ctx: Context, agent: Agent): {
    changeId: string
    items: ReadonlyArray<{ content: string; phase: string; status: string }>
    progress: Record<string, { done: number; total: number }>
  } {
    return ctx.sessionProjections.snapshot(agent.session).values['delivery-tasks'] as never
  }

  it('creates tasks.md when the file does not yet exist', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await l2Task(ctx, agent)
    resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: 'ship it', phase: 'implemented', status: 'pending' }],
    }, agent))
    const path = join(cwd, 'openspec', 'changes', 'add-thing', 'tasks.md')
    expect(readFileSync(path, 'utf8')).toBe('- [ ] ship it\n')
  })

  it('preserves the existing covers annotation while flipping the checkbox', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await l2Task(ctx, agent)
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.md'), '## 1. Setup\n\n- [ ] ship it (covers: cap/scenario)\n\n')
    resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: 'ship it', phase: 'implemented', status: 'completed' }],
    }, agent))
    expect(readFileSync(join(dir, 'tasks.md'), 'utf8'))
      .toBe('## 1. Setup\n\n- [x] ship it (covers: cap/scenario)\n\n')
  })

  it('skips writing for an l0 task without a change_id', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l0 sync', level: 'l0' }, agent))
    resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: '',
      items: [{ content: 'fix it', phase: 'implemented', status: 'pending' }],
    }, agent))
    expect(() => readFileSync(join(cwd, 'openspec', 'changes', '', 'tasks.md'), 'utf8'))
      .toThrow(/ENOENT|no such file/i)
  })

  it('skips writing for an l1 task without a change_id', async () => {
    const { ctx, agent, cwd } = await harness()
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 sync', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: '',
      items: [{ content: 'fix it', phase: 'implemented', status: 'pending' }],
    }, agent))
    expect(() => readFileSync(join(cwd, 'openspec', 'changes', '', 'tasks.md'), 'utf8'))
      .toThrow(/ENOENT|no such file/i)
  })

  it('appends new items that have no matching line on disk', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await l2Task(ctx, agent)
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.md'), '- [ ] ship it\n')
    resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [
        { content: 'ship it', phase: 'implemented', status: 'completed' },
        { content: 'verify it', phase: 'verified', status: 'pending' },
      ],
    }, agent))
    expect(readFileSync(join(dir, 'tasks.md'), 'utf8'))
      .toBe('- [x] ship it\n- [ ] verify it\n')
  })

  it('reflects a second record_tasks call in tasks.md without losing the first', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await l2Task(ctx, agent)
    const first = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: 'ship it', phase: 'implemented', status: 'pending' }],
    }, agent))
    resultTask(await execute(ctx, 'record_tasks', {
      task_id: first['id'], revision: first['revision'], change_id: 'add-thing',
      items: [{ content: 'ship it', phase: 'implemented', status: 'completed' }],
    }, agent))
    const path = join(cwd, 'openspec', 'changes', 'add-thing', 'tasks.md')
    expect(readFileSync(path, 'utf8')).toBe('- [x] ship it\n')
  })

  it('rejects a kebab-case-violating change_id without writing to disk', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await l2Task(ctx, agent)
    const result = await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'BadId',
      items: [{ content: 'ship it', phase: 'implemented', status: 'pending' }],
    }, agent)
    expect(result.isError).toBe(true)
    expect(() => readFileSync(join(cwd, 'openspec', 'changes', 'BadId', 'tasks.md'), 'utf8'))
      .toThrow(/ENOENT|no such file/i)
  })

  it('orders the projection items to match the existing tasks.md line order', async () => {
    const { ctx, agent, cwd } = await harness()
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.md'),
      '- [ ] build first\n- [ ] verify it\n- [ ] ship it\n')
    const task = await l2Task(ctx, agent)
    resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [
        { content: 'ship it', phase: 'implemented', status: 'pending' },
        { content: 'build first', phase: 'implemented', status: 'completed' },
        { content: 'verify it', phase: 'verified', status: 'in_progress' },
      ],
    }, agent))
    const view = tasksView(ctx, agent)
    expect(view.items.map(item => item.content)).toEqual(['build first', 'verify it', 'ship it'])
    expect(readFileSync(join(dir, 'tasks.md'), 'utf8'))
      .toBe('- [x] build first\n- [ ] verify it\n- [ ] ship it\n')
  })

  it('appends new model-passed items at the end of the existing tasks.md line order', async () => {
    const { ctx, agent, cwd } = await harness()
    const dir = join(cwd, 'openspec', 'changes', 'add-thing')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.md'), '- [ ] build first\n')
    const task = await l2Task(ctx, agent)
    resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [
        { content: 'ship it', phase: 'implemented', status: 'pending' },
        { content: 'build first', phase: 'implemented', status: 'completed' },
        { content: 'verify it', phase: 'verified', status: 'pending' },
      ],
    }, agent))
    const view = tasksView(ctx, agent)
    expect(view.items.map(item => item.content)).toEqual(['build first', 'ship it', 'verify it'])
    expect(readFileSync(join(dir, 'tasks.md'), 'utf8'))
      .toBe('- [x] build first\n- [ ] ship it\n- [ ] verify it\n')
  })
})

describe('tool-delivery l1 mirror path', () => {
  /** Walk an l1 task to implemented with a design document, ready to verify. */
  async function l1MirrorReady(
    ctx: Context,
    agent: Agent,
    cwd: string,
    todos: readonly { content: string; status: string }[],
  ): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: '1、做A\n2、做B', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    mkdirSync(join(cwd, '.dsh/design'), { recursive: true })
    writeFileSync(join(cwd, `.dsh/design/${String(task['id'])}.md`), '### D1 先做A\n### D2 再做B\n')
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    // An l1 task drives its work through todo_write, so its checklist arrives
    // by mirror rather than by record_tasks.
    agent.session.append('todo/write', { todos: todos as never })
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'done' }, agent))
    return resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
  }

  it('verifies an l1 task whose mirrored todo list covers request and design', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await l1MirrorReady(ctx, agent, cwd, [
      { content: '做A (covers: req/1, design/D1)', status: 'completed' },
      { content: '做B (covers: req/2, design/D2)', status: 'completed' },
    ])
    const verified = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent))
    expect(verified).toMatchObject({ phase: 'verified' })
  })

  it('blocks an l1 mirror path that leaves a design decision uncovered', async () => {
    const { ctx, agent, cwd } = await harness()
    const task = await l1MirrorReady(ctx, agent, cwd, [
      { content: '做A (covers: req/1, design/D1)', status: 'completed' },
      { content: '做B (covers: req/2)', status: 'completed' },
    ])
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('design/D2')
  })
})

describe('tool-delivery l2 scenario coverage', () => {
  /**
   * Walk an l2 task to implemented, then attempt the verified transition.
   *
   * The checklist is supplied as items the model would pass to record_tasks;
   * the same list reaches the disk through record_spec so the cross-check
   * between the two authorities agrees.
   *
   * @returns the outcome of the verified transition.
   */
  async function l2Verify(
    ctx: Context,
    agent: Agent,
    cwd: string,
    items: readonly { content: string; status: string }[],
  ): Promise<ToolExecutionResult> {
    const step = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await execute(ctx, name, args, agent)
      if (r.isError) throw new Error(`${name} FAILED: ${JSON.stringify(r.content).slice(0, 400)}`)
      return resultTask(r)
    }
    let task = await step('create_delivery_task', { objective: 'l2 work', level: 'l2' })
    const ref = (): Record<string, unknown> => ({ task_id: task['id'], revision: task['revision'] })
    task = await step('mark_analysis_done', ref())
    task = await step('record_design', { ...ref(), text: 'd' })
    task = await step('advance_delivery_task', { ...ref(), phase: 'designed' })
    const dir = join(cwd, 'openspec/changes/add-demo-change')
    mkdirSync(join(dir, 'specs/demo-cap'), { recursive: true })
    writeFileSync(join(dir, 'proposal.md'), 'why\n')
    writeFileSync(join(dir, 'design.md'), '### D1 做它\n')
    writeFileSync(join(dir, 'specs/demo-cap/spec.md'), '#### Scenario: 它应当工作\n')
    const checklist = items.map(item => `- [x] ${item.content}\n`).join('')
    task = await step('record_spec', { ...ref(), change_id: 'add-demo-change', kind: 'tasks', text: checklist })
    task = await step('record_tasks', {
      ...ref(), change_id: 'add-demo-change',
      items: items.map(item => ({ ...item, phase: 'implemented' })),
    })
    task = await step('advance_delivery_task', { ...ref(), phase: 'specified' })
    task = await step('record_change', { ...ref(), text: 'c' })
    task = await step('advance_delivery_task', { ...ref(), phase: 'implemented' })
    return execute(ctx, 'advance_delivery_task', { ...ref(), phase: 'verified' }, agent)
  }

  it('verifies an l2 task whose checklist covers every scenario and design point', async () => {
    const { ctx, agent, cwd } = await harness()
    const r = await l2Verify(ctx, agent, cwd, [
      { content: '做它 (covers: demo-cap/它应当工作, design/D1)', status: 'completed' },
    ])
    expect(r.isError).toBe(false)
  })

  it('blocks an l2 task whose checklist omits a scenario', async () => {
    const { ctx, agent, cwd } = await harness()
    const r = await l2Verify(ctx, agent, cwd, [
      { content: '做它 (covers: design/D1)', status: 'completed' },
    ])
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('demo-cap/它应当工作')
  })
})

describe('tool-delivery l0 numbered request', () => {
  it('verifies an l0 task whose numbered request has no checklist to annotate', async () => {
    const { ctx, agent } = await harness()
    // An l0 task owes no checklist, so a numbered request cannot be covered by
    // an annotation. This must not become a permanent block.
    let task = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: '1、修复甲\n2、修复乙\n3、修复丙', level: 'l0',
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    const r = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(r.isError).toBe(false)
  })
})

describe('tool-delivery verification false-positive guard', () => {
  it('verifies an l1 task whose plain request has no numbered items to cover', async () => {
    const { ctx, agent } = await harness()
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: '把按钮改成蓝色', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'd' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: '',
      items: [{ content: '改颜色', phase: 'implemented', status: 'completed' }],
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'c' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    // No numbered request items and no design document on disk means no points
    // to cover, so verification must not invent a gap.
    const r = await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
    }, agent)
    expect(r.isError).toBe(false)
  })

  it('does not invent a gap for an l2 task whose recorded design has no document', async () => {
    // The task records a design but never writes the document the record points
    // at, and its change declares no delta specs. With no readable points there
    // is nothing to cover, so verification must pass rather than manufacture a
    // gap the model cannot satisfy.
    const { ctx, agent, cwd } = await harness()
    const step = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await execute(ctx, name, args, agent)
      if (r.isError) throw new Error(`${name} FAILED: ${JSON.stringify(r.content).slice(0, 300)}`)
      return resultTask(r)
    }
    let task = await step('create_delivery_task', { objective: 'l2 work', level: 'l2' })
    const ref = (): Record<string, unknown> => ({ task_id: task['id'], revision: task['revision'] })
    task = await step('mark_analysis_done', ref())
    task = await step('record_design', { ...ref(), text: 'd' })
    task = await step('advance_delivery_task', { ...ref(), phase: 'designed' })
    const dir = join(cwd, 'openspec/changes/add-docless-change')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'proposal.md'), 'why\n')
    task = await step('record_spec', { ...ref(), change_id: 'add-docless-change', kind: 'tasks', text: '- [x] 做它\n' })
    task = await step('record_tasks', {
      ...ref(), change_id: 'add-docless-change',
      items: [{ content: '做它', phase: 'implemented', status: 'completed' }],
    })
    task = await step('advance_delivery_task', { ...ref(), phase: 'specified' })
    task = await step('record_change', { ...ref(), text: 'c' })
    task = await step('advance_delivery_task', { ...ref(), phase: 'implemented' })
    const r = await execute(ctx, 'advance_delivery_task', { ...ref(), phase: 'verified' }, agent)
    expect(r.isError).toBe(false)
  })
})

describe('tool-delivery review rounds', () => {
  /**
   * Walk an l1 task to implemented with an uncovered request item.
   *
   * The checklist carries no `covers:` annotation, so `req/1` stays uncovered
   * and each attempt spends a review round rather than passing on its own.
   */
  async function readyToReview(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: '1、做甲', level: 'l1',
    }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'd' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: '',
      items: [{ content: '做甲', phase: 'implemented', status: 'completed' }],
    }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'c' }, agent))
    return resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'implemented',
    }, agent))
  }

  /** A confirmation long enough to clear the specificity floor. */
  const CONFIRM = '已逐项核对 req/1 的实现位置与证据，确认完成'

  /** Register one more live agent on the same composed context. */
  function addAgent(ctx: Context): Agent {
    const agent = stubAgent(`delivery-tool-${Math.random()}`)
    ctx.agents.register(agent)
    return agent
  }

  it('counts a review round from the session log and records it', async () => {
    const { ctx, agent } = await harness({ maxReviewRounds: 2 })
    const task = await readyToReview(ctx, agent)
    const reviewed = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: task['id'], revision: task['revision'], phase: 'verified',
      coverage_confirmation: CONFIRM,
    }, agent))
    expect(reviewed['phase']).toBe('verified')
    // The round is durably recorded, which is what makes the count survive a
    // resume instead of living in a process-level map.
    const recorded = ctx.delivery.getTasks(agent)
    expect(recorded).toBeDefined()
    const log = agent.session.events.filter(event => event.type === 'delivery/change')
    const reviews = log.filter(event =>
      (event.data as { text?: string }).text?.startsWith('coverage review: ') === true)
    expect(reviews).toHaveLength(1)
  })

  it('does not carry a previous task rounds into a new task in the same session', async () => {
    // The count is scoped to the current task id. Without that scope, clearing
    // a task and starting another left the new task with no review budget at
    // all, because it inherited every round the cleared one had spent.
    const { ctx, agent } = await harness({ maxReviewRounds: 1 })
    const first = await readyToReview(ctx, agent)
    const reviewed = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: first['id'], revision: first['revision'], phase: 'verified',
      coverage_confirmation: CONFIRM,
    }, agent))
    expect(reviewed['phase']).toBe('verified')

    // Clear the settled task and start a fresh one in the same session.
    const settled = ctx.delivery.get(agent)
    const ref = { id: first['id'] as never, revision: settled?.revision ?? 1 }
    ctx.delivery.clear(agent, ref)
    const second = await readyToReview(ctx, agent)
    const fresh = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: second['id'], revision: second['revision'], phase: 'verified',
      coverage_confirmation: CONFIRM,
    }, agent))
    expect(fresh['phase']).toBe('verified')
  })

  it('gives each session its own review budget', async () => {
    // The counter used to be a process-level map, so rounds spent by one task
    // were charged against every other task in the process.
    const { ctx, agent } = await harness({ maxReviewRounds: 1 })
    const first = await readyToReview(ctx, agent)
    const spent = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: first['id'], revision: first['revision'], phase: 'verified',
      coverage_confirmation: CONFIRM,
    }, agent))
    expect(spent['phase']).toBe('verified')

    // A second session in the same process still has its full budget.
    const other = addAgent(ctx)
    const second = await readyToReview(ctx, other)
    const fresh = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: second['id'], revision: second['revision'], phase: 'verified',
      coverage_confirmation: CONFIRM,
    }, other))
    expect(fresh['phase']).toBe('verified')
  })
})
