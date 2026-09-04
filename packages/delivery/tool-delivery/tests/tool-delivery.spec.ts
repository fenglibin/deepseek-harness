import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import DeliveryService from '@deepseek-ai/dsh-delivery'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolDelivery from '@deepseek-ai/dsh-tool-delivery'

const testToolSignal = new AbortController().signal

/** In-memory shell whose `run` returns a fixed outcome, for post-hook tests. */
class StubShell extends ShellExecutor {
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
    return {
      exitCode: this.outcome.exitCode ?? 0,
      signal: this.outcome.signal ?? null,
      timedOut: this.outcome.timedOut ?? false,
      aborted: this.outcome.aborted ?? false,
      timeoutMs: spec.timeoutMs,
      stdout: this.outcome.stdout ?? { text: '', truncated: false },
      stderr: this.outcome.stderr ?? { text: '', truncated: false },
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

async function harness(config: toolDelivery.Config = {}, shellOutcome: Partial<ShellRunResult> = {}) {
  const ctx = new Context()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-delivery-'))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem, { cwd })
  await ctx.plugin(StubShell, shellOutcome)
  await ctx.plugin(DeliveryService)
  const fiber = await ctx.plugin(toolDelivery, config)
  const agent = stubAgent(`delivery-tool-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, fiber, agent, cwd }
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
  it('registers the six delivery tools by default', async () => {
    const { ctx } = await harness()
    for (const name of ['get_delivery_task', 'create_delivery_task', 'record_change', 'record_design', 'record_spec', 'advance_delivery_task']) {
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
    expect(ctx.tools.get('record_spec')?.presentCall?.({ task_id: 'task-1', revision: 1, text: 'the spec' })).toEqual({
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

    const designed = resultTask(await execute(ctx, 'record_design', {
      task_id: created['id'],
      revision: created['revision'],
      text: 'the design',
    }, agent))
    expect(designed).toMatchObject({ designCount: 1, revision: 2 })

    const advanced = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: designed['id'],
      revision: designed['revision'],
      phase: 'designed',
    }, agent))
    expect(advanced).toMatchObject({ phase: 'designed' })
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

    const design = resultTask(await execute(ctx, 'record_design', {
      task_id: created['id'], revision: created['revision'], text: 'the design',
    }, agent))
    const designed = resultTask(await execute(ctx, 'advance_delivery_task', {
      task_id: design['id'], revision: design['revision'], phase: 'designed',
    }, agent))
    expect(designed).toMatchObject({ phase: 'designed' })

    const spec = resultTask(await execute(ctx, 'record_spec', {
      task_id: designed['id'],
      revision: designed['revision'],
      text: 'the spec',
    }, agent))
    expect(spec).toMatchObject({ specCount: 1, revision: 4 })

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
    const design = resultTask(await execute(ctx, 'record_design', {
      task_id: created['id'], revision: created['revision'], text: 'the design',
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
    await execute(ctx, 'record_design', {
      task_id: created['id'], revision: created['revision'], text: 'the design',
    }, agent)
    const path = join(cwd, '.dsh', 'design', `${created['id']}.md`)
    expect(readFileSync(path, 'utf8')).toContain('the design')
  })

  it('writes the design to .dsh/design and the spec to openspec/changes', async () => {
    const { ctx, agent, cwd } = await harness()
    const created = resultTask(await execute(ctx, 'create_delivery_task', { objective: 'persist spec', level: 'l2' }, agent))
    const design = resultTask(await execute(ctx, 'record_design', {
      task_id: created['id'], revision: created['revision'], text: 'the design',
    }, agent))
    await execute(ctx, 'record_spec', {
      task_id: design['id'], revision: design['revision'], text: 'the spec',
    }, agent)
    expect(readFileSync(join(cwd, '.dsh', 'design', `${created['id']}.md`), 'utf8')).toContain('the design')
    expect(readFileSync(join(cwd, 'openspec', 'changes', `${created['id']}`, 'spec.md'), 'utf8')).toContain('the spec')
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
