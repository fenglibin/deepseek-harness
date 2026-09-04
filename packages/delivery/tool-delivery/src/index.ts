/**
 * Model-facing delivery-discipline tools: create a task, record changes,
 * read the current task, and advance its phase under the configured gate.
 * @module @deepseek-ai/dsh-tool-delivery
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DeliveryTaskId, nextDeliveryPhase } from '@deepseek-ai/dsh-delivery'
import type { DeliveryLevel, DeliveryPhase, DeliveryTaskRef, DeliveryView } from '@deepseek-ai/dsh-delivery'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'tool-delivery'
export const inject = ['agents', 'delivery', 'tools', 'fs', 'shell', 'systemPrompt']

/** Size proxy that auto-tiers a task to `l1` when the model omits one. */
export interface DesignThresholdConfig {
  /** Auto-tier to `l1` at or above this estimated todo-item count. */
  todoCount?: number
  /** Auto-tier to `l1` when the objective is at least this many characters. */
  descriptionChars?: number
  /** Auto-tier to `l1` at or above this estimated changed-file count. */
  touchedFiles?: number
}

/** Size proxy that auto-tiers a task to `l2` when the model omits one. */
export interface OpenspecThresholdConfig {
  /** Auto-tier to `l2` at or above this estimated todo-item count. */
  todoCount?: number
  /** Auto-tier to `l2` when the objective is at least this many characters. */
  descriptionChars?: number
}

/** Deployment policy for the delivery tools. */
export interface Config {
  /** Whether the delivery tools are registered at all. */
  enabled?: boolean
  /** Gate strength: off (no tools), advisory (remind), stateful (block). */
  enforcement?: string
  /** Size proxy: any measure at or above a threshold auto-tiers to `l1`. */
  designThreshold?: DesignThresholdConfig
  /** Size proxy: any measure at or above a threshold auto-tiers to `l2`. */
  openspecThreshold?: OpenspecThresholdConfig
  /** Whether a non-small bug fix (past the design threshold) forces `l2`. */
  requireOpenspecForBugs?: boolean
  /** Post-execution commands run before a task may reach accepted. */
  postHooks?: string[]
}

/** Schemastery config for the delivery-tool policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  enforcement: z.string().default('stateful'),
  designThreshold: z.object({
    todoCount: z.number().default(5),
    descriptionChars: z.number().default(300),
    touchedFiles: z.number().default(3),
  }).default({ todoCount: 5, descriptionChars: 300, touchedFiles: 3 }),
  openspecThreshold: z.object({
    todoCount: z.number().default(15),
    descriptionChars: z.number().default(1200),
  }).default({ todoCount: 15, descriptionChars: 1200 }),
  requireOpenspecForBugs: z.boolean().default(true),
  postHooks: z.array(z.string()).default([]),
})

/** Fully materialized tool policy. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly enforcement: 'stateful' | 'advisory' | 'off'
  readonly designTodos: number
  readonly designChars: number
  readonly designFiles: number
  readonly specTodos: number
  readonly specChars: number
  readonly requireOpenspecForBugs: boolean
  readonly postHooks: readonly string[]
}

const PHASES: readonly DeliveryPhase[] = [
  'created',
  'designed',
  'specified',
  'implemented',
  'verified',
  'accepted',
]

/** Canonical delivery-tool output, matching the compact Native JSON style. */
type DeliveryToolValue =
  | { task: null }
  | {
    task: {
      id: string
      revision: number
      objective: string
      phase: DeliveryPhase
      level: DeliveryView['level']
      changeCount: number
      designCount: number
      specCount: number
      createdAt: number
      updatedAt: number
    }
  }

const DELIVERY_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'null', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            id: { type: 'string', required: true },
            revision: { type: 'integer', required: true },
            objective: { type: 'string', required: true },
            phase: { type: 'string', required: true, enum: PHASES },
            level: { type: 'string', required: true, enum: ['l0', 'l1', 'l2'] },
            changeCount: { type: 'integer', required: true },
            designCount: { type: 'integer', required: true },
            specCount: { type: 'integer', required: true },
            createdAt: { type: 'integer', required: true },
            updatedAt: { type: 'integer', required: true },
          },
        },
      },
    },
  ],
} as const

const PHASES_DESCRIPTION = PHASES.join(' | ')

/** Stable compact model result. */
function deliveryValue(task: DeliveryView | undefined): DeliveryToolValue {
  if (task === undefined) return { task: null }
  return {
    task: {
      id: task.id,
      revision: task.revision,
      objective: task.objective,
      phase: task.phase,
      level: task.level,
      changeCount: task.changeCount,
      designCount: task.designCount,
      specCount: task.specCount,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
  }
}

/** Render the delivery-discipline policy guidance for the model. */
function guidance(): string {
  return 'Use the delivery tools to run larger pieces of work under the delivery discipline. '
    + 'create_delivery_task takes an objective and an optional level: l0 for a small fix, l1 to add a '
    + 'design, l2 to add an openspec split; omit level and it is inferred from the objective length and '
    + 'any todo_count/touched_files estimates. Before advancing to designed, record at least one design '
    + 'with record_design (writes .dsh/design/<task-id>.md); before specified, record a spec with '
    + 'record_spec (writes openspec/changes/<task-id>/spec.md); before implemented, record at least one '
    + 'change with record_change (writes .dsh/changes/<task-id>.md). Call get_delivery_task first and copy '
    + 'its exact task_id and revision into every record and advance call. Use todo_write only for '
    + 'lightweight multi-step tracking; use the delivery tools when the work must leave a design or '
    + 'change record on disk.'
}

/** Generic, args-only pending presentation shared by the delivery tools. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Resolve and authenticate the calling agent for a delivery tool. */
function deliveryAgent(ctx: Context, exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError('delivery tools require a calling agent', 'DELIVERY_TOOL_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent) {
    throw new HarnessError('delivery tools require the exact live calling agent', 'DELIVERY_TOOL_AGENT_NOT_LIVE')
  }
  return agent
}

/** Build the exact compare-and-set ref from model arguments. */
function deliveryRef(taskId: string, revision: number): DeliveryTaskRef {
  if (taskId.length === 0 || taskId !== taskId.trim()
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new HarnessError(
      'task_id must be non-empty and revision must be a positive safe integer',
      'DELIVERY_TOOL_INVALID_REF',
    )
  }
  return { id: DeliveryTaskId(taskId), revision }
}

/** Require one positive safe-integer threshold, falling back to its default. */
function positiveInt(value: number | undefined, field: string, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return resolved
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const enforcement = config.enforcement ?? 'stateful'
  if (enforcement !== 'stateful' && enforcement !== 'advisory' && enforcement !== 'off') {
    throw new TypeError("enforcement must be 'stateful', 'advisory', or 'off'")
  }
  const designTodos = positiveInt(config.designThreshold?.todoCount, 'designThreshold.todoCount', 5)
  const designChars = positiveInt(config.designThreshold?.descriptionChars, 'designThreshold.descriptionChars', 300)
  const designFiles = positiveInt(config.designThreshold?.touchedFiles, 'designThreshold.touchedFiles', 3)
  const specTodos = positiveInt(config.openspecThreshold?.todoCount, 'openspecThreshold.todoCount', 15)
  const specChars = positiveInt(config.openspecThreshold?.descriptionChars, 'openspecThreshold.descriptionChars', 1200)
  const postHooks = config.postHooks ?? []
  for (const hook of postHooks) {
    if (typeof hook !== 'string' || hook.trim().length === 0) {
      throw new TypeError('postHooks must contain only non-empty command strings')
    }
  }
  return {
    enabled: config.enabled ?? true,
    enforcement,
    designTodos,
    designChars,
    designFiles,
    specTodos,
    specChars,
    requireOpenspecForBugs: config.requireOpenspecForBugs ?? true,
    postHooks,
  }
}

/** Estimated size signals supplied by the model when it creates a task. */
interface SizeSignals {
  readonly todoCount: number
  readonly touchedFiles: number
  readonly isBug: boolean
}

/** Whether any design-threshold measure is met. */
function reachesDesign(signals: SizeSignals, resolved: ResolvedConfig): boolean {
  return signals.todoCount >= resolved.designTodos
    || signals.touchedFiles >= resolved.designFiles
}

/** Whether any openspec-threshold measure is met. */
function reachesSpec(signals: SizeSignals, objective: string, resolved: ResolvedConfig): boolean {
  return objective.length >= resolved.specChars
    || signals.todoCount >= resolved.specTodos
}

/** Infer a task size class from its size signals when the model omits one. */
function inferLevel(objective: string, signals: SizeSignals, resolved: ResolvedConfig): DeliveryLevel {
  if (reachesSpec(signals, objective, resolved)) return 'l2'
  if (resolved.requireOpenspecForBugs && signals.isBug
    && (objective.length >= resolved.designChars || reachesDesign(signals, resolved))) {
    return 'l2'
  }
  if (objective.length >= resolved.designChars || reachesDesign(signals, resolved)) return 'l1'
  return 'l0'
}

/** Append one entry to a `.dsh` artifact file, creating it when absent. */
async function appendArtifact(ctx: Context, agent: Agent, path: string, entry: string): Promise<void> {
  const cwd = agent.session.header.cwd
  const target = cwd === undefined
    ? await ctx.fs.resolve(path)
    : await ctx.fs.resolve(path, { cwd })
  const existing = await ctx.fs.stat(target)
  const prefix = existing === undefined ? '' : await ctx.fs.readText(target)
  await ctx.fs.writeText(target, `${prefix}${entry}`)
}

/** Run the configured post-hooks in order and return the first failure, if any. */
async function runPostHooks(ctx: Context, agent: Agent, hooks: readonly string[]): Promise<string | undefined> {
  for (const hook of hooks) {
    const cwd = agent.session.header.cwd
    const request: { command: string; workdir?: string } = { command: hook }
    if (cwd !== undefined) request.workdir = cwd
    const result = await ctx.shell.run(ctx.shell.resolve(request))
    if (result.exitCode === 0 && !result.timedOut && !result.aborted) continue
    const detail = result.stderr.text.trim() || result.stdout.text.trim()
    return `post-hook "${hook}" failed${detail.length > 0 ? `: ${detail}` : ''}`
  }
  return undefined
}

/** The first change, design, and spec records are prerequisites for their phases. */
function gateAdvance(view: DeliveryView | undefined, phase: DeliveryPhase): string | undefined {
  if (view === undefined) return 'no current delivery task exists'
  // Only the single legal next phase carries a record prerequisite; any other
  // target is an illegal transition the domain rejects with a precise error.
  if (phase !== nextDeliveryPhase(view.level, view.phase)) return undefined
  if (phase === 'implemented' && view.changeCount === 0) {
    return 'at least one change record is required before the task reaches implemented'
  }
  if (phase === 'designed' && view.designCount === 0) {
    return 'at least one design record is required before the task reaches designed'
  }
  if (phase === 'specified' && view.specCount === 0) {
    return 'at least one spec record is required before the task reaches specified'
  }
  return undefined
}

/** Register the delivery tools under the configured gate strength. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled || resolved.enforcement === 'off') return

  ctx.systemPrompt.section({
    name: 'tool:delivery',
    order: ctx.systemPrompt.getSectionOrder('TOOL_DELIVERY'),
    text: guidance(),
  })

  ctx.tools.register(defineTool({
    name: 'get_delivery_task',
    description: 'Read the current delivery task, including its exact id/revision, objective, phase, '
      + 'level, recorded change count, and timestamps. Call this before advancing or recording a change.',
    parameters: {},
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute(_args, exec) {
      const agent = deliveryAgent(ctx, exec)
      return Promise.resolve(deliveryValue(ctx.delivery.get(agent)))
    },
    presentCall: () => present('Read delivery task', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'create_delivery_task',
    description: 'Create one delivery task in the created phase. Use it for a concrete piece of work '
      + 'that should produce a change record; level selects the discipline path (l0 small fix, l1 adds '
      + 'a design, l2 adds an openspec split). When level is omitted it is inferred from the objective '
      + 'length plus optional todo_count and touched_files estimates. An accepted task may be replaced.',
    parameters: {
      objective: { type: 'string', required: true, description: 'The concrete task objective.' },
      level: { type: 'string', enum: ['l0', 'l1', 'l2'], description: 'Task-size class; inferred when omitted.' },
      todo_count: { type: 'number', description: 'Estimated todo-item count used for size tiering.' },
      touched_files: { type: 'number', description: 'Estimated changed-file count used for size tiering.' },
      is_bug: { type: 'boolean', description: 'Whether this is a bug fix; may force l2 under requireOpenspecForBugs.' },
    },
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      const signals: SizeSignals = {
        todoCount: typeof args.todo_count === 'number' && Number.isSafeInteger(args.todo_count) ? args.todo_count : 0,
        touchedFiles: typeof args.touched_files === 'number' && Number.isSafeInteger(args.touched_files) ? args.touched_files : 0,
        isBug: args.is_bug === true,
      }
      const level = args.level === undefined ? inferLevel(args.objective, signals, resolved) : args.level
      const view = ctx.delivery.create(agent, { objective: args.objective, level })
      return Promise.resolve(deliveryValue(view))
    },
    presentCall: args => present('Create delivery task', 'other', args.objective),
  }))

  ctx.tools.register(defineTool({
    name: 'record_change',
    description: 'Record one change against the current delivery task without changing its phase, and append it to .dsh/changes/<task-id>.md. '
      + 'Every task must record at least one change before it can reach implemented.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Exact id returned by get_delivery_task.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_delivery_task.' },
      text: { type: 'string', required: true, description: 'Non-empty description of the change.' },
    },
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      const ref = deliveryRef(args.task_id, args.revision)
      const view = ctx.delivery.recordChange(agent, ref, args.text)
      await appendArtifact(ctx, agent, `.dsh/changes/${view.id}.md`, `- [revision ${view.revision}] ${args.text}\n`)
      return deliveryValue(view)
    },
    presentCall: args => present('Record change', 'other', args.text),
  }))

  ctx.tools.register(defineTool({
    name: 'record_design',
    description: 'Record one design against the current delivery task without changing its phase, and append it to .dsh/design/<task-id>.md. '
      + 'A task must record at least one design before it can reach designed.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Exact id returned by get_delivery_task.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_delivery_task.' },
      text: { type: 'string', required: true, description: 'Non-empty description of the design.' },
    },
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      const ref = deliveryRef(args.task_id, args.revision)
      const view = ctx.delivery.recordDesign(agent, ref, args.text)
      await appendArtifact(ctx, agent, `.dsh/design/${view.id}.md`, `- [revision ${view.revision}] ${args.text}\n`)
      return deliveryValue(view)
    },
    presentCall: args => present('Record design', 'other', args.text),
  }))

  ctx.tools.register(defineTool({
    name: 'record_spec',
    description: 'Record one spec against the current delivery task without changing its phase, and append it to openspec/changes/<task-id>/spec.md. '
      + 'A task must record at least one spec before it can reach specified.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Exact id returned by get_delivery_task.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_delivery_task.' },
      text: { type: 'string', required: true, description: 'Non-empty description of the spec.' },
    },
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      const ref = deliveryRef(args.task_id, args.revision)
      const view = ctx.delivery.recordSpec(agent, ref, args.text)
      await appendArtifact(ctx, agent, `openspec/changes/${view.id}/spec.md`, `- [revision ${view.revision}] ${args.text}\n`)
      return deliveryValue(view)
    },
    presentCall: args => present('Record spec', 'other', args.text),
  }))

  ctx.tools.register(defineTool({
    name: 'advance_delivery_task',
    description: `Advance the current delivery task to the next phase in its level's order (${PHASES_DESCRIPTION}). `
      + 'The phase must be the single legal next phase; skipping a required phase is rejected.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Exact id returned by get_delivery_task.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_delivery_task.' },
      phase: { type: 'string', required: true, enum: PHASES, description: 'The target next phase.' },
    },
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      const ref = deliveryRef(args.task_id, args.revision)
      const current = ctx.delivery.get(agent)
      const gate = gateAdvance(current, args.phase)
      if (gate !== undefined) {
        if (resolved.enforcement === 'stateful') {
          throw new HarnessError(gate, 'DELIVERY_GATE_BLOCKED')
        }
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: `Delivery reminder: ${gate}` }],
          source: { kind: 'plugin', plugin: 'tool-delivery', form: 'notice', summary: 'delivery gate' },
        }))
      }
      if (args.phase === 'accepted' && resolved.postHooks.length > 0) {
        const failure = await runPostHooks(ctx, agent, resolved.postHooks)
        if (failure !== undefined) {
          if (resolved.enforcement === 'stateful') {
            throw new HarnessError(failure, 'DELIVERY_POST_HOOK_FAILED')
          }
          exec.deferContext(createUserMessage({
            content: [{ type: 'text', text: `Delivery reminder: ${failure}` }],
            source: { kind: 'plugin', plugin: 'tool-delivery', form: 'notice', summary: 'delivery post-hook' },
          }))
        }
      }
      return deliveryValue(ctx.delivery.advance(agent, ref, args.phase))
    },
    presentCall: args => present(
      `Advance delivery task to ${args.phase}`,
      'other',
      args.task_id,
    ),
  }))
}
