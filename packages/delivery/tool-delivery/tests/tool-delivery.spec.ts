import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import DeliveryService from '@deepseek-ai/dsh-delivery'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolDelivery from '@deepseek-ai/dsh-tool-delivery'
import { orderItemsByMarkdown, renderTasksMarkdown } from '@deepseek-ai/dsh-tool-delivery/src/index.ts'

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

/** In-memory shell whose `run` returns a fixed outcome, for post-hook tests. */
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
    throw new Error('StubShell.start is not used by post-hook tests')
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

/** Minimal settings provider that resolves one overridden policy section. */
class StubSettings {
  constructor(private readonly override: Record<string, unknown>) {}

  installSection<T>(
    _owner: Context,
    ns: string,
    _schema: unknown,
    entry: T,
    hooks: { setSource(current: () => T): void; onChange(): void },
  ): void {
    expect(ns).toBe('delivery')
    const merged = { ...(entry as Record<string, unknown>), ...this.override } as T
    hooks.setSource(() => merged)
    hooks.onChange()
  }
}

async function harness(
  config: toolDelivery.Config = {},
  shellOutcome: Partial<ShellRunResult> = {},
  settings?: StubSettings,
) {
  const ctx = new Context()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-delivery-'))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem, { cwd })
  await ctx.plugin(StubShell, shellOutcome)
  if (settings !== undefined) ctx.provide('settings', settings)
  await ctx.plugin(DeliveryService)
  const fiber = await ctx.plugin(toolDelivery, config)
  const agent = stubAgent(`delivery-tool-${Math.random()}`)
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
    expect(() => { toolDelivery.apply(ctx, { designThreshold: { descriptionChars: 0 } }) }).toThrow(TypeError)
    expect(() => { toolDelivery.apply(ctx, { designThreshold: { descriptionChars: 1.5 } }) }).toThrow(TypeError)
    expect(() => { toolDelivery.apply(ctx, { designThreshold: { todoCount: 0 } }) }).toThrow(TypeError)
    expect(() => { toolDelivery.apply(ctx, { designThreshold: { touchedFiles: 1.5 } }) }).toThrow(TypeError)
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

  it('auto-tiers a long objective to l1', async () => {
    const { ctx, agent } = await harness({ designThreshold: { descriptionChars: 10 } })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'a very long objective' }, agent))
    expect(created).toMatchObject({ level: 'l1' })
  })

  it('keeps a short objective at l0 under a raised threshold', async () => {
    const { ctx, agent } = await harness({ designThreshold: { descriptionChars: 10 } })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'short' }, agent))
    expect(created).toMatchObject({ level: 'l0' })
  })

  it('accepts an explicit level override regardless of objective length', async () => {
    const { ctx, agent } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'x', level: 'l1' }, agent))
    expect(created).toMatchObject({ level: 'l1' })
  })

  it('auto-tiers on a todo_count estimate', async () => {
    const { ctx, agent } = await harness({ designThreshold: { todoCount: 5 } })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'short', todo_count: 6 }, agent))
    expect(created).toMatchObject({ level: 'l1' })
  })

  it('auto-tiers on a touched_files estimate', async () => {
    const { ctx, agent } = await harness({ designThreshold: { touchedFiles: 3 } })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'short', touched_files: 4 }, agent))
    expect(created).toMatchObject({ level: 'l1' })
  })

  it('forces l2 for a non-small bug under requireOpenspecForBugs', async () => {
    const { ctx, agent } = await harness({ designThreshold: { descriptionChars: 10 } })
    const created = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: 'a bug fix that is definitely not small', is_bug: true,
    }, agent))
    expect(created).toMatchObject({ level: 'l2' })
  })

  it('keeps a bug at l0 when below the design threshold', async () => {
    const { ctx, agent } = await harness({ designThreshold: { descriptionChars: 10 } })
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'tiny', is_bug: true }, agent))
    expect(created).toMatchObject({ level: 'l0' })
  })

  it('does not force l2 for a bug when requireOpenspecForBugs is off', async () => {
    const { ctx, agent } = await harness({ designThreshold: { descriptionChars: 10 }, requireOpenspecForBugs: false })
    const created = resultTask(await execute(ctx, 'create_delivery_task', {
      objective: 'a bug fix that is definitely not small', is_bug: true,
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

describe('tool-delivery post-hooks', () => {
  /** Create an l0 task and walk it to verified, ready for acceptance. */
  async function advanceToVerified(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'post-hook', level: 'l0' }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'verified' }, agent))
    return task
  }

  it('runs post-hooks before accepting a task', async () => {
    const { ctx, agent } = await harness({ postHooks: ['pnpm run test'] })
    const verified = await advanceToVerified(ctx, agent)
    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted' })
  })

  it('blocks acceptance when a post-hook fails under stateful', async () => {
    const { ctx, agent } = await harness(
      { postHooks: ['pnpm run test'] },
      { exitCode: 1, stderr: { text: 'tests failed', truncated: false } },
    )
    const verified = await advanceToVerified(ctx, agent)
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('reminds but still accepts when a post-hook fails under advisory', async () => {
    const { ctx, agent } = await harness(
      { enforcement: 'advisory', postHooks: ['pnpm run test'] },
      { exitCode: 1, stderr: { text: 'tests failed', truncated: false } },
    )
    const verified = await advanceToVerified(ctx, agent)
    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted' })
  })

  it('rejects a blank post-hook command before registering anything', () => {
    const ctx = new Context()
    expect(() => { toolDelivery.apply(ctx, { postHooks: ['  '] }) }).toThrow(TypeError)
  })

  it('blocks acceptance when a post-hook times out', async () => {
    const { ctx, agent } = await harness(
      { postHooks: ['slow command'] },
      { timedOut: true, exitCode: null },
    )
    const verified = await advanceToVerified(ctx, agent)
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('blocks acceptance when a post-hook is aborted', async () => {
    const { ctx, agent } = await harness(
      { postHooks: ['abortable command'] },
      { aborted: true, exitCode: null },
    )
    const verified = await advanceToVerified(ctx, agent)
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('blocks acceptance for a failed post-hook with no output', async () => {
    const { ctx, agent } = await harness(
      { postHooks: ['silent failure'] },
      { exitCode: 1 },
    )
    const verified = await advanceToVerified(ctx, agent)
    const result = await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('accepts a non-l2 task whose checklist records an empty change id', async () => {
    const { ctx, agent } = await harness()
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 post-hook', level: 'l1' }, agent))
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
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l2 post-hook', level: 'l2' }, agent))
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
    // An l2 task owns a change, so its acceptance still validates that change.
    expect((ctx.get('shell') as StubShell).commands).toContain('openspec validate add-thing --strict --json')
  })

  it('passes the session cwd to post-hooks', async () => {
    const ctx = new Context()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-delivery-ph-'))
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: mkdtempSync(join(tmpdir(), 'dsh-delivery-fs-')) })
    await ctx.plugin(StubShell)
    await ctx.plugin(DeliveryService)
    await ctx.plugin(toolDelivery, { postHooks: ['pnpm run test'] })
    const id = SessionId(`delivery-ph-${Math.random()}`)
    const agent = stubAgent(`ph-agent-${Math.random()}`, Session.create(
      id,
      undefined,
      { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd },
    ))
    ctx.agents.register(agent)
    const verified = await advanceToVerified(ctx, agent)
    const accepted = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: verified['id'], revision: verified['revision'], phase: 'accepted',
    }, agent))
    expect(accepted).toMatchObject({ phase: 'accepted' })
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

  it('does not create a task for a short request', async () => {
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'fix the typo' }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)).toBeUndefined()
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

  it('creates an l2 task for a multi-part request the old rule graded as l1', async () => {
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: MULTI_PART_REQUEST }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)?.level).toBe('l2')
  })

  it('creates an l2 task when a short request hits a strong signal', async () => {
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: '重构这个模块的内部实现' }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)?.level).toBe('l2')
  })

  it('leaves a medium-signal request to the model instead of creating an l1 task', async () => {
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: '新增一个小能力' }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)).toBeUndefined()
    const injected = agent.inbox.nextStep
    expect(injected.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'tool-delivery')).toBe(true)
  })

  it('injects the grading rubric once per turn when no signal matches', async () => {
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'fix the typo' }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)).toBeUndefined()
    const injected = agent.inbox.nextStep
    expect(injected.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'tool-delivery')).toBe(true)
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'fix the typo again' }],
      source: { kind: 'user' },
    })])
    expect(agent.inbox.nextStep.length).toBe(injected.length)
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
  it('grades with the settings-resolved policy when a provider is mounted', async () => {
    const { ctx, agent } = await harness({}, {}, new StubSettings({
      openspecThreshold: { todoCount: 15, descriptionChars: 20 },
    }))
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'a'.repeat(25) }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)?.level).toBe('l2')
  })

  it('keeps the composition policy when no provider is mounted', async () => {
    const { ctx, agent } = await harness()
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: 'a'.repeat(25) }],
      source: { kind: 'user' },
    })])
    expect(ctx.delivery.get(agent)).toBeUndefined()
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

  /** Walk an l1 task (with a design record) to verified. */
  async function advanceL1ToVerified(ctx: Context, agent: Agent): Promise<Record<string, unknown>> {
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'l1 task', level: 'l1' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    task = resultTask(await execute(ctx, 'record_change', { task_id: task['id'], revision: task['revision'], text: 'the fix' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'implemented' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'verified' }, agent))
    return task
  }

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

describe('tool-delivery sandboxed artifact writes', () => {
  // The session cwd and the filesystem's default cwd must live OUTSIDE the
  // platform temp areas: `writableRoots` grants `/tmp` and `os.tmpdir()` under
  // workspace-write, so a temp-dir session cwd would pass containment for the
  // wrong reason and make the regression invisible.
  const sandboxRoots: string[] = []
  afterEach(() => {
    for (const root of sandboxRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * Mount the confining filesystem backend and the shared policy service, then
   * register a delivery agent whose session cwd differs from the filesystem's
   * default cwd (the harness process cwd the bare `resolve()` would fall back
   * to). Delivery artifacts must still land under the session cwd, which is the
   * exact deployed-session shape that previously denied `.dsh/*` writes.
   */
  async function sandboxHarness(): Promise<{
    ctx: Context
    agent: Agent
    sessionCwd: string
    fsDefaultCwd: string
  }> {
    const ctx = new Context()
    const sessionCwd = mkdtempSync(join(homedir(), 'dsh-delivery-sandbox-cwd-'))
    const fsDefaultCwd = mkdtempSync(join(homedir(), 'dsh-delivery-sandbox-fs-'))
    sandboxRoots.push(sessionCwd, fsDefaultCwd)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fsDefaultCwd })
    await ctx.plugin(SandboxedFileSystem, { cwd: fsDefaultCwd })
    await ctx.plugin(StubShell)
    await ctx.plugin(DeliveryService)
    await ctx.plugin(toolDelivery, {})
    const id = SessionId(`delivery-sandbox-${Math.random()}`)
    const agent = stubAgent(`sandbox-agent-${Math.random()}`, Session.create(
      id,
      undefined,
      { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: sessionCwd },
    ))
    ctx.agents.register(agent)
    return { ctx, agent, sessionCwd, fsDefaultCwd }
  }

  it('writes the design artifact under the session cwd through a workspace-write sandbox', async () => {
    const { ctx, agent, sessionCwd } = await sandboxHarness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'sandbox design', level: 'l1' }, agent))
    const analyzed = resultTask(await execute(ctx, 'mark_analysis_done', {
      task_id: created['id'], revision: created['revision'],
    }, agent))
    await execute(ctx, 'record_design', {
      task_id: analyzed['id'], revision: analyzed['revision'], text: 'the sandboxed design',
    }, agent)
    expect(readFileSync(join(sessionCwd, '.dsh', 'design', `${created['id']}.md`), 'utf8'))
      .toContain('the sandboxed design')
  })

  it('writes the change artifact under the session cwd through a workspace-write sandbox', async () => {
    const { ctx, agent, sessionCwd } = await sandboxHarness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'sandbox change', level: 'l0' }, agent))
    await execute(ctx, 'record_change', {
      task_id: created['id'], revision: created['revision'], text: 'the sandboxed change',
    }, agent)
    expect(readFileSync(join(sessionCwd, '.dsh', 'changes', `${created['id']}.md`), 'utf8'))
      .toContain('the sandboxed change')
  })

  it('writes tasks.md under the session cwd through a workspace-write sandbox', async () => {
    const { ctx, agent, sessionCwd } = await sandboxHarness()
    let task = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'sandbox tasks', level: 'l2' }, agent))
    task = resultTask(await execute(ctx, 'mark_analysis_done', { task_id: task['id'], revision: task['revision'] }, agent))
    task = resultTask(await execute(ctx, 'record_design', { task_id: task['id'], revision: task['revision'], text: 'the design' }, agent))
    task = resultTask(await execute(ctx, 'advance_delivery_task', { task_id: task['id'], revision: task['revision'], phase: 'designed' }, agent))
    resultTask(await execute(ctx, 'record_tasks', {
      task_id: task['id'], revision: task['revision'], change_id: 'add-thing',
      items: [{ content: 'ship it', phase: 'implemented', status: 'pending' }],
    }, agent))
    expect(readFileSync(join(sessionCwd, 'openspec', 'changes', 'add-thing', 'tasks.md'), 'utf8'))
      .toBe('- [ ] ship it\n')
  })
})
