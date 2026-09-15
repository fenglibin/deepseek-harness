/**
 * Model-facing delivery-discipline tools: create a task, record changes,
 * read the current task, and advance its phase under the configured gate.
 * @module @deepseek-ai/dsh-tool-delivery
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { DeliveryTaskId, nextDeliveryPhase } from '@deepseek-ai/dsh-delivery'
import type { DeliveryLevel, DeliveryPhase, DeliveryTaskItem, DeliveryTaskRef, DeliveryView } from '@deepseek-ai/dsh-delivery'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  coverageReport,
  describeCoverageGap,
  designPoints,
  hasCoverageGap,
  parseChecklist,
  scenarioPoints,
} from './coverage.ts'
import type { CoveragePoint } from './coverage.ts'
import {
  DEFAULT_MEDIUM_SIGNALS,
  DEFAULT_STRONG_SIGNALS,
  DEFAULT_WEAK_SIGNALS,
  gradeObjective,
} from './grading.ts'
import type { GradingPolicy } from './grading.ts'
import { changeArtifactPath, isValidChangeId } from './openspec.ts'
import type { SpecKind } from './openspec.ts'

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
  /** Auto-create a task at pre-step when a direct human request meets the size proxy. */
  autoDetect?: boolean
  /** Patterns whose first hit classifies a request as `l2`. */
  strongSignals?: string[]
  /** Patterns whose second hit classifies as `l2` and whose first hit classifies as `l1`. */
  mediumSignals?: string[]
  /** Patterns whose second hit classifies as `l1`. */
  weakSignals?: string[]
  /** How many review rounds a blocked gate allows before it hard-blocks. */
  maxReviewRounds?: number
}

/** Schemastery config for the delivery-tool policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  enforcement: z.string().default('stateful'),
  designThreshold: z.object({
    todoCount: z.number().default(5),
    descriptionChars: z.number().default(60),
    touchedFiles: z.number().default(3),
  }).default({ todoCount: 5, descriptionChars: 60, touchedFiles: 3 }),
  openspecThreshold: z.object({
    todoCount: z.number().default(15),
    descriptionChars: z.number().default(200),
  }).default({ todoCount: 15, descriptionChars: 200 }),
  requireOpenspecForBugs: z.boolean().default(true),
  postHooks: z.array(z.string()).default([]),
  autoDetect: z.boolean().default(true),
  strongSignals: z.array(z.string()).default([...DEFAULT_STRONG_SIGNALS]),
  mediumSignals: z.array(z.string()).default([...DEFAULT_MEDIUM_SIGNALS]),
  weakSignals: z.array(z.string()).default([...DEFAULT_WEAK_SIGNALS]),
  maxReviewRounds: z.number().default(2),
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
  readonly autoDetect: boolean
  readonly strongSignals: readonly string[]
  readonly mediumSignals: readonly string[]
  readonly weakSignals: readonly string[]
  readonly maxReviewRounds: number
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
      analysisDone: boolean
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
            analysisDone: { type: 'boolean', required: true },
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
      analysisDone: task.analysisDone,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
  }
}

/** Size-classification signals the model uses to choose a delivery level. */
const SIZE_RUBRIC =
  'Choose the level from these size signals. Any one strong signal makes the task non-small: '
  + 'it introduces or changes a structure contract (a capability seam, a session event, a persisted '
  + 'schema or projection, a public API or protocol, or a cross-version data format) (l2); it is a '
  + 'non-small bug fix or a change to data format, protocol, compatibility, or security (l2); it spans '
  + 'host and client or at least three packages, or changes a widely-referenced public symbol (l1); it '
  + 'adds a whole feature or capability, or performs a large-scale refactor or migration (l1). Two or '
  + 'more weak signals also make it l1: at least two design decisions that need weighing, decomposable '
  + 'into at least three independent verifiable subtasks, or multi-role coordination. Otherwise it is '
  + 'an l0 small fix.'

/** Visible text of one user message. */
function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
}

/** Direct human request text from a claimed step batch, joined across messages. */
function directHumanText(messages: readonly UserMessage[]): string {
  return messages
    .filter(message => message.source.kind === 'user')
    .map(messageText)
    .join('\n')
    .trim()
}

/** Render the delivery-discipline policy guidance for the model. */
function guidance(): string {
  return 'Use the delivery tools to run larger pieces of work under the delivery discipline. '
    + 'Classify the request size first: a non-small task (l1/l2) needs a design or a split, an l0 is a '
    + 'small fix; see create_delivery_task for the size signals. create_delivery_task takes an objective '
    + 'and an optional level: l0 for a small fix, l1 to add a design, l2 to add an openspec split; omit '
    + 'level and it is inferred from the objective length and any todo_count/touched_files estimates. '
    + 'After creating the task, first clarify and align the requirement with the user, then call '
    + 'mark_analysis_done to mark analysis complete; writing a design is blocked until then. Every level '
    + 'follows that order, l1 included: confirm the requirement before implementing, and record the '
    + 'breakdown with record_tasks so the task list reflects the real plan. '
    + 'Write full analysis or design drafts to ordinary project paths (e.g. docs/); record_design then '
    + 'records a concise summary pointing at those drafts, not a duplicate full document. '
    + 'Before advancing to designed, record at least one design with record_design (writes '
    + '.dsh/design/<task-id>.md); before specified, record the OpenSpec change with record_spec (writes '
    + 'proposal.md, design.md, tasks.md and a spec delta under openspec/changes/<change_id>/); before '
    + 'implemented, record at least one change with '
    + 'record_change (writes .dsh/changes/<task-id>.md). Record the checklist with record_tasks (empty '
    + 'change_id for a non-l2 task) so it persists across turns and drives verification. '
    + 'Call get_delivery_task first and copy its exact '
    + 'task_id and revision into every record and advance call. Use todo_write only for lightweight '
    + 'multi-step tracking; use the delivery tools when the work must leave a design or change record on disk.'
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

/** Require a list of non-empty signal patterns, falling back to the defaults. */
function signalList(
  value: readonly string[] | undefined,
  field: string,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined) return fallback
  for (const pattern of value) {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      throw new TypeError(`${field} must contain only non-empty pattern strings`)
    }
  }
  return [...value]
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const enforcement = config.enforcement ?? 'stateful'
  if (enforcement !== 'stateful' && enforcement !== 'advisory' && enforcement !== 'off') {
    throw new TypeError("enforcement must be 'stateful', 'advisory', or 'off'")
  }
  const designTodos = positiveInt(config.designThreshold?.todoCount, 'designThreshold.todoCount', 5)
  const designChars = positiveInt(config.designThreshold?.descriptionChars, 'designThreshold.descriptionChars', 60)
  const designFiles = positiveInt(config.designThreshold?.touchedFiles, 'designThreshold.touchedFiles', 3)
  const specTodos = positiveInt(config.openspecThreshold?.todoCount, 'openspecThreshold.todoCount', 15)
  const specChars = positiveInt(config.openspecThreshold?.descriptionChars, 'openspecThreshold.descriptionChars', 200)
  const postHooks = config.postHooks ?? []
  for (const hook of postHooks) {
    if (typeof hook !== 'string' || hook.trim().length === 0) {
      throw new TypeError('postHooks must contain only non-empty command strings')
    }
  }
  const strongSignals = signalList(config.strongSignals, 'strongSignals', DEFAULT_STRONG_SIGNALS)
  const mediumSignals = signalList(config.mediumSignals, 'mediumSignals', DEFAULT_MEDIUM_SIGNALS)
  const weakSignals = signalList(config.weakSignals, 'weakSignals', DEFAULT_WEAK_SIGNALS)
  const maxReviewRounds = positiveInt(config.maxReviewRounds, 'maxReviewRounds', 2)
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
    autoDetect: config.autoDetect ?? true,
    strongSignals,
    mediumSignals,
    weakSignals,
    maxReviewRounds,
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

/** Review rounds already spent per task and phase, counted in-process. */
const reviewRounds = new Map<string, number>()

/** Shortest confirmation that is specific enough to release a coverage gap. */
const MIN_CONFIRMATION_CHARS = 20

/**
 * Collect the coverage gaps of the agent's current change: points the delta
 * specs and the design declare that no checklist item claims, and items
 * claiming points that do not exist. Points are read from the spec headings
 * themselves because `openspec show --json` reports scenarios without names.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @returns a one-line gap description, or `undefined` when coverage is
 * complete, when no change is recorded, or when the OpenSpec CLI is absent so
 * that the validate gate remains the authority.
 */
async function coverageGap(ctx: Context, agent: Agent): Promise<string | undefined> {
  const recorded = ctx.delivery.getTasks(agent)
  if (recorded === undefined) return undefined
  const changeId = recorded.changeId
  const cwd = agent.session.header.cwd
  const read = async (path: string): Promise<string | undefined> => {
    try {
      const target = cwd === undefined
        ? await ctx.fs.resolve(path)
        : await ctx.fs.resolve(path, { cwd })
      return await ctx.fs.readText(target)
    } catch {
      return undefined
    }
  }
  const shown = await ctx.shell.run(ctx.shell.resolve({
    command: `openspec show ${changeId} --json`,
    ...cwd === undefined ? {} : { workdir: cwd },
  }))
  if (shown.exitCode !== 0) return undefined
  let capabilities: readonly string[] = []
  try {
    const parsed = JSON.parse(shown.stdout.text) as {
      deltas?: ReadonlyArray<{ spec?: string }>
    }
    capabilities = (parsed.deltas ?? [])
      .map(delta => delta.spec ?? '')
      .filter(spec => spec.length > 0)
  } catch {
    return undefined
  }
  const points: CoveragePoint[] = []
  for (const capability of capabilities) {
    const spec = await read(`openspec/changes/${changeId}/specs/${capability}/spec.md`)
    if (spec !== undefined) points.push(...scenarioPoints(capability, spec))
  }
  const design = await read(`openspec/changes/${changeId}/design.md`)
  if (design !== undefined) points.push(...designPoints(design))
  const tasks = await read(`openspec/changes/${changeId}/tasks.md`)
  if (tasks === undefined || points.length === 0) return undefined
  const report = coverageReport(points, parseChecklist(tasks))
  if (!hasCoverageGap(report)) return undefined
  return describeCoverageGap(report)
}

/** Whether any openspec-threshold measure is met. */
function reachesSpec(signals: SizeSignals, objective: string, resolved: ResolvedConfig): boolean {
  return objective.length >= resolved.specChars
    || signals.todoCount >= resolved.specTodos
}

/** Project the resolved policy onto the pure grading inputs. */
function gradingPolicyOf(resolved: ResolvedConfig): GradingPolicy {
  return {
    specChars: resolved.specChars,
    strongSignals: resolved.strongSignals,
    mediumSignals: resolved.mediumSignals,
    weakSignals: resolved.weakSignals,
  }
}

/**
 * Infer a task size class: the programmatic three-tier decision decides first,
 * and the model's own size estimates only raise the level when grading found
 * nothing, so a short but wide request cannot be graded down.
 */
function inferLevel(objective: string, signals: SizeSignals, resolved: ResolvedConfig): DeliveryLevel {
  const graded = gradeObjective(objective, gradingPolicyOf(resolved))
  if (graded === 'l2') return 'l2'
  if (resolved.requireOpenspecForBugs && signals.isBug
    && (objective.length >= resolved.designChars || reachesDesign(signals, resolved))) {
    return 'l2'
  }
  if (reachesSpec(signals, objective, resolved)) return 'l2'
  if (graded === 'l1' || reachesDesign(signals, resolved)
    || objective.length >= resolved.designChars) return 'l1'
  return 'l0'
}

/** The four OpenSpec change artifacts `record_spec` may write. */
const SPEC_KINDS: readonly SpecKind[] = ['proposal', 'design', 'tasks', 'spec']

/**
 * Resolve the per-call sandbox policy for the agent's session, or `undefined`
 * when no sandbox-policy service is mounted. Delivery artifact writes must
 * pass this to `ctx.fs.writeText`: a workspace-write sandbox fences the write
 * against the session's own cwd this way, whereas omitting it lets the backend
 * fall back to the harness process cwd — which denied `.dsh/*` and
 * `openspec/*` writes in deployed sessions whose cwd differs from the harness
 * process.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @returns the session-scoped policy, or `undefined` without a mounted service.
 */
function sandboxPolicyFor(ctx: Context, agent: Agent): SandboxExecutionPolicy | undefined {
  const service = ctx.reflect.get('sandboxPolicy') as SandboxPolicyService | undefined
  return service?.resolve({ session: agent.session })
}

/**
 * Write one artifact file, replacing any prior content. OpenSpec parses
 * `tasks.md` and the spec deltas structurally, so revision prefixes that suit
 * the `.dsh` records must not be added here.
 */
async function writeArtifact(ctx: Context, agent: Agent, path: string, content: string): Promise<void> {
  const cwd = agent.session.header.cwd
  const target = cwd === undefined
    ? await ctx.fs.resolve(path)
    : await ctx.fs.resolve(path, { cwd })
  await ctx.fs.writeText(target, content, undefined, undefined, sandboxPolicyFor(ctx, agent))
}

/** Append one entry to a `.dsh` artifact file, creating it when absent. */
async function appendArtifact(ctx: Context, agent: Agent, path: string, entry: string): Promise<void> {
  const cwd = agent.session.header.cwd
  const target = cwd === undefined
    ? await ctx.fs.resolve(path)
    : await ctx.fs.resolve(path, { cwd })
  const existing = await ctx.fs.stat(target)
  const prefix = existing === undefined ? '' : await ctx.fs.readText(target)
  await ctx.fs.writeText(target, `${prefix}${entry}`, undefined, undefined, sandboxPolicyFor(ctx, agent))
}

/** Checkbox regex reused by `renderTasksMarkdown`; matches `[ ]`, `[x]`, `[X]`. */
const TASKS_CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/
/** Trailing `(covers: ...)` or `(覆盖: ...)` annotation preserved on each line. */
const TASKS_COVERS = /\((?:covers|覆盖)\s*:\s*[^)]*\)\s*$/i

/**
 * Render the `openspec/changes/<change>/tasks.md` body that mirrors one
 * checklist. Lines whose checkbox content matches an item have their checkbox
 * flipped to `[x]` (completed) or `[ ]` (pending or in_progress); any trailing
 * `(covers: ...)` annotation and unrelated lines are preserved so headings,
 * blank lines, and the model's own grouping survive the rewrite. Items with
 * no matching existing line are appended at the end.
 * @param existing - prior tasks.md body; empty when the file is absent.
 * @param items - authoritative checklist from the latest `record_tasks` call.
 * @returns the rewritten tasks.md body.
 */
export function renderTasksMarkdown(
  existing: string,
  items: readonly DeliveryTaskItem[],
): string {
  // A trailing newline is the file-end convention; stripping it before
  // splitting avoids a phantom empty element that would otherwise turn into
  // a stray blank line on every rewrite.
  const stripped = existing.endsWith('\n') ? existing.slice(0, -1) : existing
  const lines = stripped.length === 0 ? [] : stripped.split('\n')
  const consumed = new Set<number>()
  const output: string[] = []
  for (const line of lines) {
    const match = TASKS_CHECKBOX.exec(line)
    if (match === null || match[2] === undefined) {
      output.push(line)
      continue
    }
    const body = match[2].trim()
    const annotation = TASKS_COVERS.exec(body)
    const lineContent = annotation === null
      ? body
      : body.slice(0, annotation.index).trim()
    const matchingIdx = items.findIndex(
      (item, idx) => !consumed.has(idx) && item.content === lineContent,
    )
    if (matchingIdx < 0) {
      output.push(line)
      continue
    }
    consumed.add(matchingIdx)
    const item = items[matchingIdx] as DeliveryTaskItem
    const done = item.status === 'completed'
    output.push(line.replace(/^(\s*[-*]\s+)\[[ xX]\]/, `$1${done ? '[x]' : '[ ]'}`))
  }
  for (let idx = 0; idx < items.length; idx += 1) {
    if (consumed.has(idx)) continue
    const item = items[idx] as DeliveryTaskItem
    const checkbox = item.status === 'completed' ? '- [x]' : '- [ ]'
    output.push(`${checkbox} ${item.content}`)
  }
  const body = output.join('\n')
  return body.length === 0 ? '' : `${body}\n`
}

/**
 * Order one checklist so its items appear in the same order as their matches
 * in an existing `openspec/changes/<change>/tasks.md` body, with items absent
 * from the body appended at the end. Used by `record_tasks` so the in-memory
 * `delivery-tasks` projection and the on-disk artifact agree on order — the
 * float card reads the projection, so a model-passed order different from
 * the file would otherwise drift from the canonical tasks.md listing.
 * @param existing - prior tasks.md body; empty when the file is absent.
 * @param items - authoritative checklist from the latest `record_tasks` call.
 * @returns items in tasks.md line order, with unmatched items at the end in
 * their input order.
 */
export function orderItemsByMarkdown(
  existing: string,
  items: readonly DeliveryTaskItem[],
): DeliveryTaskItem[] {
  const stripped = existing.endsWith('\n') ? existing.slice(0, -1) : existing
  const lines = stripped.length === 0 ? [] : stripped.split('\n')
  const consumed = new Set<number>()
  const ordered: DeliveryTaskItem[] = []
  for (const line of lines) {
    const match = TASKS_CHECKBOX.exec(line)
    if (match === null || match[2] === undefined) continue
    const body = match[2].trim()
    const annotation = TASKS_COVERS.exec(body)
    const lineContent = annotation === null
      ? body
      : body.slice(0, annotation.index).trim()
    const matchingIdx = items.findIndex(
      (item, idx) => !consumed.has(idx) && item.content === lineContent,
    )
    if (matchingIdx < 0) continue
    consumed.add(matchingIdx)
    ordered.push(items[matchingIdx] as DeliveryTaskItem)
  }
  for (let idx = 0; idx < items.length; idx += 1) {
    if (consumed.has(idx)) continue
    ordered.push(items[idx] as DeliveryTaskItem)
  }
  return ordered
}

/**
 * Read the body of `openspec/changes/<changeId>/tasks.md` for the session's cwd.
 * Returns the empty string when the file is absent.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param changeId - verb-led kebab-case OpenSpec change id.
 * @throws {HarnessError} with `DELIVERY_TASKS_WRITE_FAILED` when stat succeeds
 * but the read fails; a missing file is the only expected case where stat
 * returns `undefined` and the read is skipped.
 */
async function readTasksMarkdown(ctx: Context, agent: Agent, changeId: string): Promise<string> {
  const cwd = agent.session.header.cwd
  const path = `openspec/changes/${changeId}/tasks.md`
  const target = cwd === undefined
    ? await ctx.fs.resolve(path)
    : await ctx.fs.resolve(path, { cwd })
  // `fs.stat` returns undefined for a missing file, matching `appendArtifact`;
  // a thrown error here would be a real backend fault worth surfacing.
  if ((await ctx.fs.stat(target)) === undefined) return ''
  try {
    return await ctx.fs.readText(target)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HarnessError(
      `failed to read ${path}: ${message}`,
      'DELIVERY_TASKS_WRITE_FAILED',
    )
  }
}

/**
 * Write the rendered `openspec/changes/<changeId>/tasks.md` body. A write
 * failure surfaces as `DELIVERY_TASKS_WRITE_FAILED` so the model can retry
 * rather than see a silent drift between the in-memory checklist and the disk
 * artifact OpenSpec reads.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param changeId - verb-led kebab-case OpenSpec change id.
 * @param content - the full rendered tasks.md body to write.
 */
async function writeTasksMarkdown(
  ctx: Context,
  agent: Agent,
  changeId: string,
  content: string,
): Promise<void> {
  const cwd = agent.session.header.cwd
  const path = `openspec/changes/${changeId}/tasks.md`
  const target = cwd === undefined
    ? await ctx.fs.resolve(path)
    : await ctx.fs.resolve(path, { cwd })
  try {
    await ctx.fs.writeText(target, content, undefined, undefined, sandboxPolicyFor(ctx, agent))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HarnessError(
      `failed to write ${path}: ${message}`,
      'DELIVERY_TASKS_WRITE_FAILED',
    )
  }
}

/** Issue messages reported by one `validate --json` result, when it produced JSON. */
function validationIssues(stdout: string): readonly string[] {
  try {
    const parsed = JSON.parse(stdout) as {
      items?: ReadonlyArray<{ id?: string; issues?: ReadonlyArray<{ message?: string }> }>
    }
    const messages: string[] = []
    for (const item of parsed.items ?? []) {
      for (const issue of item.issues ?? []) {
        if (typeof issue.message === 'string') messages.push(`${item.id ?? 'change'}: ${issue.message}`)
      }
    }
    return messages
  } catch {
    return []
  }
}

/** Run the configured post-hooks in order and return the first failure, if any. */
async function runPostHooks(ctx: Context, agent: Agent, hooks: readonly string[]): Promise<string | undefined> {
  for (const hook of hooks) {
    const cwd = agent.session.header.cwd
    const request: { command: string; workdir?: string } = { command: hook }
    if (cwd !== undefined) request.workdir = cwd
    const result = await ctx.shell.run(ctx.shell.resolve(request))
    if (result.exitCode === 0 && !result.timedOut && !result.aborted) continue
    const issues = validationIssues(result.stdout.text)
    const detail = issues.length > 0
      ? issues.join('; ')
      : result.stderr.text.trim() || result.stdout.text.trim()
    return `post-hook "${hook}" failed${detail.length > 0 ? `: ${detail}` : ''}`
  }
  return undefined
}

/** Done and total counts of the checkbox lines in one markdown checklist. */
function checkboxCounts(text: string): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const line of text.split('\n')) {
    const match = /^\s*[-*]\s+\[([ xX])\]/.exec(line)
    if (match === null) continue
    total += 1
    if ((match[1] ?? '').toLowerCase() === 'x') done += 1
  }
  return { done, total }
}

/**
 * Compare the recorded checklist with `tasks.md` on disk. The disk file is the
 * authority OpenSpec reads, so a checklist that only claims completion is a
 * mismatch rather than a pass.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @returns a mismatch description, or `undefined` when the two agree or no
 * checklist has been recorded.
 */
async function checklistMismatch(ctx: Context, agent: Agent): Promise<string | undefined> {
  const recorded = ctx.delivery.getTasks(agent)
  if (recorded === undefined) return undefined
  // A non-l2 task has no OpenSpec change, so its checklist is not cross-checked
  // against a tasks.md on disk.
  const current = ctx.delivery.get(agent)
  if (current === undefined || current.level !== 'l2') return undefined
  const path = `openspec/changes/${recorded.changeId}/tasks.md`
  const cwd = agent.session.header.cwd
  const target = cwd === undefined
    ? await ctx.fs.resolve(path)
    : await ctx.fs.resolve(path, { cwd })
  let text: string
  try {
    text = await ctx.fs.readText(target)
  } catch {
    return `${path} is missing; write the checklist before implementing`
  }
  const disk = checkboxCounts(text)
  const reported = recorded.items.reduce(
    (counts, item) => ({
      done: counts.done + (item.status === 'completed' ? 1 : 0),
      total: counts.total + 1,
    }),
    { done: 0, total: 0 },
  )
  if (disk.done === reported.done && disk.total === reported.total) return undefined
  // A differing total means the checklist contents drifted — a content
  // mismatch, an added item, or a removed item — while an equal total with a
  // differing done count means the statuses alone are stale. The two have
  // different remedies, so name the failing one instead of a generic "align".
  if (disk.total !== reported.total) {
    return `${path} has ${disk.total} checkbox line(s) but the recorded checklist has ${reported.total} item(s): `
      + 'their contents drifted (a content mismatch, an added item, or a removed item). '
      + 'Rewrite tasks.md with record_spec(kind: "tasks") or re-record record_tasks with contents matching tasks.md.'
  }
  return `${path} has ${disk.done}/${disk.total} done but the recorded checklist reports ${reported.done}/${reported.total}: `
    + 're-record record_tasks to sync the statuses before implementing.'
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

/** Reject or remind when requirement analysis is not yet complete. */
function gateAnalysisDone(
  ctx: Context,
  agent: Agent,
  exec: ToolRunContext,
  policy: () => ResolvedConfig,
): void {
  const current = ctx.delivery.get(agent)
  if (current === undefined || current.analysisDone) return
  const message = 'requirement analysis is not complete; call mark_analysis_done before writing a design'
  if (policy().enforcement === 'stateful') {
    throw new HarnessError(message, 'DELIVERY_GATE_BLOCKED')
  }
  exec.deferContext(createUserMessage({
    content: [{ type: 'text', text: `Delivery reminder: ${message}` }],
    source: { kind: 'plugin', plugin: 'tool-delivery', form: 'notice', summary: 'delivery analysis' },
  }))
}

/** Why an l2 task refuses the lightweight todo list. */
const TODO_BLOCKED_REASON = 'this delivery task is l2, so its work is tracked by the OpenSpec checklist '
  + 'instead: write openspec/changes/<change_id>/tasks.md with record_spec(kind: \'tasks\') and report the '
  + 'same checklist with record_tasks. todo_write is disabled while this task is l2.'

/** Ask the model to grade a request the programmatic scan did not classify as `l2`. */
const GRADING_RUBRIC = 'Delivery grading: the automatic size scan did not classify this request as l2, so '
  + 'decide whether it needs a delivery task and at which level. Call create_delivery_task with l2 when it '
  + 'changes a structure contract (a capability seam, a session event, a persisted schema or projection, a '
  + 'public API or protocol, or a cross-version data format), or when it is a non-small bug fix touching '
  + 'data format, protocol, compatibility, or security. Call it with l1 when it spans host and client, '
  + 'touches at least three packages, changes a widely referenced public symbol, or adds a whole feature. '
  + 'Do nothing when the request is a small fix.'

/** The settings slice this plugin uses, kept local to avoid a hard dependency. */
interface SettingsSectionHost {
  installSection<T>(
    owner: Context,
    ns: string,
    schema: z<T>,
    entry: T,
    hooks: { setSource(current: () => T): void; onChange(): void },
  ): void
}

/**
 * The settings provider when one is mounted. Read through `reflect` because
 * `ctx.settings` is declared as always present and its proxy trap rejects
 * access from a plugin that does not inject the service.
 */
function optionalSettings(ctx: Context): SettingsSectionHost | undefined {
  return ctx.reflect.get('settings') as SettingsSectionHost | undefined
}

/**
 * Attach the policy to the settings service when one is mounted and return a
 * reader for the policy currently in force. Without a provider the reader
 * returns the composition-resolved policy unchanged.
 * @param ctx - plugin context.
 * @param config - composition config used as the settings base and fallback.
 * @param fallback - policy resolved from the composition config.
 * @returns thunk returning the authoritative policy.
 */
function installPolicy(ctx: Context, config: Config, fallback: ResolvedConfig): () => ResolvedConfig {
  let current: ResolvedConfig = fallback
  const settings = optionalSettings(ctx)
  if (settings === undefined) return () => current
  let source: () => Config = () => config
  settings.installSection(ctx, 'delivery', Config, config, {
    setSource: (next) => { source = next },
    onChange: () => { current = resolveConfig(source()) },
  })
  return () => current
}

/** Register the delivery tools under the configured gate strength. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled || resolved.enforcement === 'off') return
  const policy = installPolicy(ctx, config, resolved)

  ctx.systemPrompt.section({
    name: 'tool:delivery',
    order: ctx.systemPrompt.getSectionOrder('TOOL_DELIVERY'),
    text: guidance(),
  })

  if (resolved.autoDetect) {
    const rubricInjected = new Set<string>()
    ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
      if (signal.aborted) return next()
      try {
        if (ctx.delivery.get(agent) === undefined) {
          const objective = directHumanText(messages)
          if (objective.length > 0) {
            // The automatic path grades the text alone; the model's own size
            // estimates only exist when it calls create_delivery_task itself.
            // Only a graded l2 creates a task here: l0 and l1 both go to the
            // model, because a single medium or two weak keyword hits are too
            // thin a basis for imposing the discipline on a request the model
            // may read as a small fix.
            const level = gradeObjective(objective, gradingPolicyOf(policy()))
            if (level === 'l2') {
              ctx.delivery.create(agent, { objective, level })
            } else {
              // Hand the rubric to the model once per turn so it can declare
              // a level for a request the scan could not settle.
              const key = `${agent.id}:${turn}`
              if (!rubricInjected.has(key)) {
                rubricInjected.add(key)
                agent.inject(createUserMessage({
                  content: [{ type: 'text', text: GRADING_RUBRIC }],
                  source: {
                    kind: 'plugin',
                    plugin: 'tool-delivery',
                    form: 'notice',
                    summary: 'delivery size grading',
                  },
                }))
              }
            }
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`delivery auto-detect failed: ${message}; continuing the turn`)
      }
      return next()
    })
  }

  // An l2 task owns one authoritative checklist, so the lightweight list is
  // refused there rather than allowed to drift from it.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'todo_write') return next()
    const agent = exec.agent
    if (agent === undefined || ctx.agents.get(agent.id) !== agent) return next()
    const current = ctx.delivery.get(agent)
    if (current === undefined || current.level !== 'l2') return next()
    if (policy().enforcement !== 'stateful') return next()
    return { kind: 'deny', reason: TODO_BLOCKED_REASON }
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
      + 'that should produce a change record. ' + SIZE_RUBRIC + ' When level is omitted it is inferred '
      + 'from the objective length plus optional todo_count and touched_files estimates. An accepted task may be replaced.',
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
      const level = args.level === undefined ? inferLevel(args.objective, signals, policy()) : args.level
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
      gateAnalysisDone(ctx, agent, exec, policy)
      const view = ctx.delivery.recordDesign(agent, ref, args.text)
      await appendArtifact(ctx, agent, `.dsh/design/${view.id}.md`, `- [revision ${view.revision}] ${args.text}\n`)
      return deliveryValue(view)
    },
    presentCall: args => present('Record design', 'other', args.text),
  }))

  ctx.tools.register(defineTool({
    name: 'mark_analysis_done',
    description: 'Mark requirement analysis and alignment complete for the current delivery task. '
      + 'Call this after clarifying the requirement with the user and before writing any design; '
      + 'record_design and record_spec(kind: design) are blocked until analysis is marked done.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Exact id returned by get_delivery_task.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_delivery_task.' },
    },
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      const ref = deliveryRef(args.task_id, args.revision)
      return Promise.resolve(deliveryValue(ctx.delivery.markAnalyzed(agent, ref)))
    },
    presentCall: () => present('Mark analysis done', 'other'),
  }))

  ctx.tools.register(defineTool({
    name: 'record_spec',
    description: 'Record one OpenSpec change artifact against the current delivery task without changing its '
      + 'phase, writing openspec/changes/<change_id>/proposal.md (why and what), design.md (technical decisions), '
      + 'tasks.md (checkbox checklist), or specs/<capability>/spec.md (delta requirements, each with at least one '
      + '#### Scenario: and a SHALL/MUST statement). change_id must be verb-led kebab-case (add-, update-, '
      + 'remove-, refactor-). In design.md, name each decision with a `### D<n> <title>` heading. In tasks.md, '
      + 'anchor each checkbox to the point it implements with a trailing `(covers: <capability>/<Scenario name>, '
      + 'design/D<n>)` annotation, so verification can confirm every scenario and decision is covered. '
      + 'A task must record at least one spec before it can reach specified.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Exact id returned by get_delivery_task.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_delivery_task.' },
      change_id: { type: 'string', required: true, description: 'Verb-led kebab-case OpenSpec change id.' },
      kind: { type: 'string', required: true, enum: SPEC_KINDS, description: 'Which change artifact to write.' },
      capability: { type: 'string', description: 'Kebab-case capability directory; required when kind is spec.' },
      text: { type: 'string', required: true, description: 'Non-empty content of the artifact.' },
    },
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      const ref = deliveryRef(args.task_id, args.revision)
      // The design artifact is also a design document, so it obeys the same
      // requirement-analysis prerequisite as record_design.
      if (args.kind === 'design') gateAnalysisDone(ctx, agent, exec, policy)
      const path = changeArtifactPath(args.change_id, args.kind, args.capability)
      const view = ctx.delivery.recordSpec(agent, ref, args.text)
      await writeArtifact(ctx, agent, path, args.text)
      return deliveryValue(view)
    },
    presentCall: args => present(`Record ${args.kind}`, 'other', args.text),
  }))

  ctx.tools.register(defineTool({
    name: 'record_tasks',
    description: 'Record the implementation checklist for the current delivery task, replacing any earlier '
      + 'list. Each item is { content, phase, status }: a short description, the lifecycle phase it belongs to '
      + '(created/designed/specified/implemented/verified/accepted), and its progress status '
      + '(pending/in_progress/completed). Call this for every level, l1 included, before starting the work: '
      + 'todo_write is only a per-turn scratch list and is cleared at the next turn, while this checklist '
      + 'persists and is what the progress panel and verification read. The checklist drives the per-phase '
      + 'progress shown for the task and '
      + 'is checked against openspec tasks.md before the task may reach implemented, so keep it aligned with '
      + 'that file.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Exact id returned by get_delivery_task.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_delivery_task.' },
      change_id: { type: 'string', required: true, description: 'Verb-led kebab-case OpenSpec change id; empty string for a non-l2 task.' },
      items: {
        type: 'array',
        required: true,
        description: 'Complete checklist; each entry has content, phase, and status.',
      },
    },
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      const ref = deliveryRef(args.task_id, args.revision)
      const changeId = typeof args.change_id === 'string' ? args.change_id.trim() : ''
      const current = ctx.delivery.get(agent)
      // The change id is later interpolated into the `openspec validate`
      // command, so an l2 task must carry the kebab-case grammar that cannot
      // carry shell metacharacters; a non-l2 task records an empty id.
      if (current?.level === 'l2' && !isValidChangeId(changeId)) {
        throw new HarnessError(
          'change_id must be verb-led kebab-case (add-, update-, remove-, refactor-)',
          'DELIVERY_INVALID_TASKS',
        )
      }
      const items = Array.isArray(args.items) ? args.items : []
      // Checklist entries cross the model boundary, so the service's strict
      // decoder judges them; the cast carries unvalidated JSON there.
      const raw = items as unknown as readonly DeliveryTaskItem[]
      // An l2 task owns an OpenSpec tasks.md, so its checklist must be read
      // once, reordered to the file's line order, and written back so the
      // in-memory projection and the on-disk artifact agree on both order and
      // status. A non-l2 task records the model-passed order unchanged and
      // leaves the filesystem untouched.
      const writesTasks = changeId.length > 0 && isValidChangeId(changeId)
      const existing = writesTasks ? await readTasksMarkdown(ctx, agent, changeId) : ''
      const tasks = writesTasks ? orderItemsByMarkdown(existing, raw) : raw
      ctx.delivery.recordTasks(agent, ref, changeId, tasks)
      // The on-disk `tasks.md` is what OpenSpec parses and what
      // `checklistMismatch` reads at advance time, so the in-memory checklist
      // and the file must agree after every write.
      if (writesTasks) {
        await writeTasksMarkdown(ctx, agent, changeId, renderTasksMarkdown(existing, tasks))
      }
      return deliveryValue(ctx.delivery.get(agent))
    },
    presentCall: args => present('Record tasks', 'other', args.change_id),
  }))

  ctx.tools.register(defineTool({
    name: 'advance_delivery_task',
    description: `Advance the current delivery task to the next phase in its level's order (${PHASES_DESCRIPTION}). `
      + 'The phase must be the single legal next phase; skipping a required phase is rejected.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Exact id returned by get_delivery_task.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_delivery_task.' },
      phase: { type: 'string', required: true, enum: PHASES, description: 'The target next phase.' },
      coverage_confirmation: { type: 'string', description: 'Required when advancing to accepted on a task with design or spec records: state that every recorded design/spec is implemented. Also releases a verified-stage coverage gap: explain each uncovered or mis-anchored point specifically, since a bare confirmation is rejected.' },
    },
    output: {
      schema: DELIVERY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: DeliveryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      let ref = deliveryRef(args.task_id, args.revision)
      const current = ctx.delivery.get(agent)
      // The disk checklist is what OpenSpec reads, so implementing may only
      // begin once the recorded checklist agrees with it.
      if (args.phase === 'implemented') {
        const mismatch = await checklistMismatch(ctx, agent)
        if (mismatch !== undefined) {
          if (policy().enforcement === 'stateful') {
            throw new HarnessError(mismatch, 'DELIVERY_GATE_BLOCKED')
          }
          exec.deferContext(createUserMessage({
            content: [{ type: 'text', text: `Delivery reminder: ${mismatch}` }],
            source: {
              kind: 'plugin',
              plugin: 'tool-delivery',
              form: 'notice',
              summary: 'delivery checklist',
            },
          }))
        }
      }
      if (args.phase === 'verified') {
        const gap = await coverageGap(ctx, agent)
        if (gap !== undefined) {
          const key = `${args.task_id}:verified`
          const rounds = (reviewRounds.get(key) ?? 0) + 1
          reviewRounds.set(key, rounds)
          const confirmation = typeof args.coverage_confirmation === 'string'
            ? args.coverage_confirmation.trim()
            : ''
          const specific = confirmation.length >= MIN_CONFIRMATION_CHARS
          if (specific && rounds <= policy().maxReviewRounds) {
            // A specific confirmation releases the gap and is recorded, so a
            // later reader sees who reviewed what rather than a silent pass.
            const view = ctx.delivery.recordChange(agent, ref, `coverage review: ${confirmation}`)
            await appendArtifact(
              ctx,
              agent,
              `.dsh/changes/${view.id}.md`,
              `- [revision ${view.revision}] coverage review: ${confirmation}\n`,
            )
            ref = { id: view.id, revision: view.revision }
          } else {
            throw new HarnessError(
              `delivery coverage gap: ${gap}. Resolve it, or confirm each gap specifically with `
              + 'coverage_confirmation; a bare "done" is not accepted.',
              'DELIVERY_GATE_BLOCKED',
            )
          }
        }
        // A non-l2 task verifies against its recorded checklist: every item
        // must be completed. An l2 task is verified by coverage instead.
        const recorded = ctx.delivery.getTasks(agent)
        if (current !== undefined && current.level !== 'l2' && recorded !== undefined) {
          const unfinished = recorded.items.filter(item => item.status !== 'completed')
          if (unfinished.length > 0) {
            const message = `delivery checklist has ${unfinished.length} unfinished item(s); complete them before verifying`
            if (policy().enforcement === 'stateful') {
              throw new HarnessError(message, 'DELIVERY_GATE_BLOCKED')
            }
            exec.deferContext(createUserMessage({
              content: [{ type: 'text', text: `Delivery reminder: ${message}` }],
              source: { kind: 'plugin', plugin: 'tool-delivery', form: 'notice', summary: 'delivery checklist' },
            }))
          }
        }
      }
      const gate = gateAdvance(current, args.phase)
      if (gate !== undefined) {
        if (policy().enforcement === 'stateful') {
          throw new HarnessError(gate, 'DELIVERY_GATE_BLOCKED')
        }
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: `Delivery reminder: ${gate}` }],
          source: { kind: 'plugin', plugin: 'tool-delivery', form: 'notice', summary: 'delivery gate' },
        }))
      }
      const needsCoverage = args.phase === 'accepted' && current !== undefined
        && (current.designCount > 0 || current.specCount > 0)
      const confirmation = needsCoverage
        ? (typeof args.coverage_confirmation === 'string' ? args.coverage_confirmation.trim() : '')
        : ''
      if (needsCoverage && confirmation.length === 0) {
        const message = 'at least one design or spec record is unconfirmed; provide coverage_confirmation stating each was implemented'
        if (policy().enforcement === 'stateful') {
          throw new HarnessError(message, 'DELIVERY_GATE_BLOCKED')
        }
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: `Delivery reminder: ${message}` }],
          source: { kind: 'plugin', plugin: 'tool-delivery', form: 'notice', summary: 'delivery gate' },
        }))
      }
      if (args.phase === 'accepted') {
        // Validation targets this task's own change id, so unrelated legacy
        // changes under openspec/changes/ cannot block acceptance. The grammar
        // is re-checked here rather than trusted from the recording: only an l2
        // task is validated when it records, and the id is interpolated into a
        // shell command below. A non-l2 task records an empty id, and a blank
        // target would turn the command into a bare `openspec validate`, which
        // validates nothing and always fails.
        const changeId = ctx.delivery.getTasks(agent)?.changeId
        const hooks = changeId === undefined || !isValidChangeId(changeId)
          ? policy().postHooks
          : [`openspec validate ${changeId} --strict --json`, ...policy().postHooks]
        if (hooks.length > 0) {
          const failure = await runPostHooks(ctx, agent, hooks)
          if (failure !== undefined) {
            if (policy().enforcement === 'stateful') {
              throw new HarnessError(failure, 'DELIVERY_POST_HOOK_FAILED')
            }
            exec.deferContext(createUserMessage({
              content: [{ type: 'text', text: `Delivery reminder: ${failure}` }],
              source: { kind: 'plugin', plugin: 'tool-delivery', form: 'notice', summary: 'delivery post-hook' },
            }))
          }
        }
      }
      if (args.phase === 'accepted' && current !== undefined) {
        if (confirmation.length > 0) {
          const view = ctx.delivery.recordChange(agent, ref, `coverage confirmation: ${confirmation}`)
          await appendArtifact(ctx, agent, `.dsh/changes/${view.id}.md`, `- [revision ${view.revision}] coverage confirmation: ${confirmation}\n`)
          ref = { id: view.id, revision: view.revision }
        }
        const latest = ctx.delivery.get(agent)
        if (latest !== undefined && latest.changeCount === 0) {
          const view = ctx.delivery.recordChange(agent, ref, `task accepted: ${latest.objective}`)
          await appendArtifact(ctx, agent, `.dsh/changes/${view.id}.md`, `- [revision ${view.revision}] task accepted: ${latest.objective}\n`)
          ref = { id: view.id, revision: view.revision }
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
