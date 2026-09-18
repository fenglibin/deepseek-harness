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
import { BlockAssembler, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the lightweight-model Context merge (ctx.lightweightModel).
import type {} from '@deepseek-ai/dsh-lightweight-model'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  GRADING_CHARACTER_FLOOR,
  gradeByLength,
  parseGradedLevel,
} from './grading.ts'
import { changeArtifactPath, isValidChangeId } from './openspec.ts'
import type { SpecKind } from './openspec.ts'
import {
  ACCEPTANCE_RECORD_PREFIX,
  COVERAGE_REVIEW_PREFIX,
  MIN_CONFIRMATION_CHARS,
  acceptanceGap,
  checklistGap,
  checklistMismatch,
  coverageGap,
  requirementCoverageGap,
  reviewRoundsSpent,
  verificationCommandFailure,
} from './verification.ts'
import type { AcceptanceGap } from './verification.ts'

export const name = 'tool-delivery'
export const inject = ['agents', 'delivery', 'tools', 'fs', 'shell', 'systemPrompt', 'llm']

/** Size proxy that auto-tiers a task to `l1` when the model omits one. */
export interface DesignThresholdConfig {
  /** Auto-tier to `l1` at or above this estimated todo-item count. */
  todoCount?: number
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

/** The tier rules used when the deployment configures none. */
export const DEFAULT_GRADING_PROMPT = [
  'You classify one software request into a delivery tier. Answer with exactly one label and nothing else:',
  'l0, l1, or l2.',
  '',
  'l2 — the work changes a contract other code or deployments depend on: a capability seam, a session event,',
  'a persisted schema or projection, a public API or protocol, a cross-version data format, or an authentication,',
  'permission, sandbox, or other security boundary. Also l2 when it is a non-small bug fix touching data format,',
  'protocol, compatibility, or security.',
  '',
  'l1 — the work needs a design decision written down before it is implemented: it spans host and client, touches',
  'at least three packages, changes a widely referenced public symbol, adds a whole feature or capability, or is a',
  'significant refactor or migration.',
  '',
  'l0 — a local, self-contained fix with no structural effect: wording, a typo, a style or layout tweak, a renamed',
  'local variable, a small isolated bug.',
  '',
  'Judge the intent of the work, not the vocabulary it happens to contain. A small edit that merely mentions a',
  'sensitive path or filename is still l0. When the request is genuinely between two tiers, choose the higher one.',
].join('\n')

/** Deployment policy for the delivery tools. */
export interface Config {
  /** Whether the delivery tools are registered at all. */
  enabled?: boolean
  /** Gate strength: off (no tools), advisory (remind), stateful (block). */
  enforcement?: string
  /** Size proxy: model-supplied estimates at or above a threshold auto-tier to `l1`. */
  designThreshold?: DesignThresholdConfig
  /**
   * The length floor that grades a request to `l2` without asking a model,
   * plus the model-supplied estimate that does the same.
   */
  openspecThreshold?: OpenspecThresholdConfig
  /** Whether a non-small bug fix (past the design threshold) forces `l2`. */
  requireOpenspecForBugs?: boolean
  /**
   * Names of the prompt commands the model must carry out before a task may
   * reach `verified`. Names rather than command text because the prompt body
   * lives in the `prompt-commands` settings section: editing a command there
   * updates every task that selected it, and the selection stays readable in
   * the settings document.
   */
  verificationCommands?: string[]
  /** Auto-create a task at pre-step when a direct human request meets the size proxy. */
  autoDetect?: boolean
  /**
   * The tier rules, as the system prompt of the grading call.
   *
   * Carried as text rather than as code so a deployment can retune what counts
   * as `l0`/`l1`/`l2` without a code change. Keyword vocabularies previously
   * decided this and were removed: substring matching cannot express the
   * semantic difference between "fix a comment in auth.ts" and "change the
   * auth protocol", so every vocabulary both under- and over-matched.
   */
  gradingPrompt?: string
  /** How many review rounds a blocked gate allows before it hard-blocks. */
  maxReviewRounds?: number
}

/** Schemastery config for the delivery-tool policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  enforcement: z.string().default('stateful'),
  designThreshold: z.object({
    todoCount: z.number().default(5),
    touchedFiles: z.number().default(3),
  }).default({ todoCount: 5, touchedFiles: 3 }),
  openspecThreshold: z.object({
    todoCount: z.number().default(15),
    descriptionChars: z.number().default(200),
  }).default({ todoCount: 15, descriptionChars: 200 }),
  requireOpenspecForBugs: z.boolean().default(true),
  verificationCommands: z.array(z.string()).default([]),
  autoDetect: z.boolean().default(true),
  gradingPrompt: z.string().default(DEFAULT_GRADING_PROMPT),
  maxReviewRounds: z.number().default(2),
})

/** Fully materialized tool policy. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly enforcement: 'stateful' | 'advisory' | 'off'
  readonly designTodos: number
  readonly designFiles: number
  readonly specTodos: number
  readonly specChars: number
  readonly requireOpenspecForBugs: boolean
  readonly verificationCommands: readonly string[]
  readonly autoDetect: boolean
  readonly gradingPrompt: string
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
    + 'Verification covers three inputs — the original request, the task list, and the design documents. '
    + 'For an l1 or l2 task it requires every point to be claimed by a COMPLETED checklist item through a '
    + 'trailing `(covers: <key>)` annotation on that item\'s content. The keys are: `req/<n>` for the n-th '
    + 'numbered item of the original request (so a request written as "1、… 2、… 3、…" needs req/1, req/2 and '
    + 'req/3), `design/<Dn>` for each `### D<n>` heading in a design document, and '
    + '`<capability>/<Scenario name>` for each `#### Scenario:` in the change\'s spec delta. An l1 task '
    + 'driven by todo_write still needs these annotations: write the item content as '
    + '"the work (covers: req/1, design/D2)". An l0 task owes no checklist, so it carries no annotations '
    + 'and verifies against the request alone. '
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

/**
 * Whether an existing task still claims the session against a new direct request.
 *
 * A finished (`accepted`) task has released its claim, so the next request starts
 * its own task. An unfinished `l0` is replaceable by policy; an unfinished
 * `l1`/`l2` keeps its claim because larger work needs continuity across turns.
 * @param current - the session's current task, or undefined when it has none.
 * @returns true when this task must keep the session.
 */
function holdsClaim(current: DeliveryView | undefined): boolean {
  return current !== undefined && current.level !== 'l0' && current.phase !== 'accepted'
}

/**
 * Retire the current task when the discipline policy allows the next one to
 * take its place, then create that task.
 *
 * Two different rules decide whether a new task may start, and they must agree:
 *
 * - The **domain** (`DeliveryService.create`) already accepts a new task when the
 *   current one is `accepted` — that task is finished, so it no longer claims the
 *   session. Its own `create` call handles that case, so this function does not
 *   clear an accepted task; clearing it first would write a tombstone the domain
 *   does not need.
 * - **Policy** decides the remaining case, through {@link holdsClaim}: an
 *   unfinished `l0` task is a small fix the next direct request may replace. Only
 *   this branch has to clear first, and the clear leaves a durable tombstone so
 *   the replaced task stays traceable.
 *
 * Leaving the accepted case out let a finished task block the session forever: no
 * tool clears a task, so every later request was refused and ran without any
 * delivery task at all.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param objective - the new task's objective.
 * @param level - the new task's size class.
 * @returns the created live view.
 */
function createReplacingL0(
  ctx: Context,
  agent: Agent,
  objective: string,
  level: DeliveryLevel,
): DeliveryView {
  const current = ctx.delivery.get(agent)
  if (current !== undefined && holdsClaim(current)) {
    throw new HarnessError(
      `delivery task "${current.id}" already exists with phase "${current.phase}"; `
      + 'only an l0 task or an accepted task may be replaced, so advance or clear it first',
      'DELIVERY_TOOL_TASK_EXISTS',
    )
  }
  if (current !== undefined && current.level === 'l0' && current.phase !== 'accepted') {
    ctx.delivery.clear(agent, { id: current.id, revision: current.revision })
  }
  return ctx.delivery.create(agent, { objective, level })
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
  const designFiles = positiveInt(config.designThreshold?.touchedFiles, 'designThreshold.touchedFiles', 3)
  const specTodos = positiveInt(config.openspecThreshold?.todoCount, 'openspecThreshold.todoCount', 15)
  const specChars = positiveInt(config.openspecThreshold?.descriptionChars, 'openspecThreshold.descriptionChars', GRADING_CHARACTER_FLOOR)
  const verificationCommands = config.verificationCommands ?? []
  for (const name of verificationCommands) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError('verificationCommands must contain only non-empty command names')
    }
  }
  // An empty grading prompt would make the grading call answer with nothing and
  // silently fall back to l1 for every request, so the misconfiguration is
  // refused here rather than degrading every later grade.
  const gradingPrompt = config.gradingPrompt ?? DEFAULT_GRADING_PROMPT
  if (gradingPrompt.trim().length === 0) {
    throw new TypeError('gradingPrompt must be a non-empty prompt')
  }
  const maxReviewRounds = positiveInt(config.maxReviewRounds, 'maxReviewRounds', 2)
  return {
    enabled: config.enabled ?? true,
    enforcement,
    designTodos,
    designFiles,
    specTodos,
    specChars,
    requireOpenspecForBugs: config.requireOpenspecForBugs ?? true,
    verificationCommands,
    autoDetect: config.autoDetect ?? true,
    gradingPrompt,
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


/** Whether any openspec-threshold measure is met. */
function reachesSpec(signals: SizeSignals, resolved: ResolvedConfig): boolean {
  return signals.todoCount >= resolved.specTodos
}

/**
 * Raise a tier with the model's own size estimates and the bug policy.
 *
 * This is the deterministic half of grading: the estimates come from the model
 * that wrote them rather than from text matching, and each rule is a plain
 * comparison, so nothing here can misread a request. The estimates may only
 * ever raise the tier the grading call produced, so a request the model itself
 * judged large cannot be graded down by a shorter objective.
 * @param level - the tier from the length floor or the grading call.
 * @param objective - direct human request text.
 * @param signals - size estimates the caller supplied.
 * @param resolved - deployment policy.
 * @returns the final tier, never lower than the one passed in.
 */
function raiseByEstimates(
  level: DeliveryLevel,
  objective: string,
  signals: SizeSignals,
  resolved: ResolvedConfig,
): DeliveryLevel {
  if (level === 'l2') return 'l2'
  const design = reachesDesign(signals, resolved)
  // A non-small bug owes the OpenSpec set because its blast radius is unknown
  // from the request text alone; the estimate decides "non-small".
  if (resolved.requireOpenspecForBugs && signals.isBug && (design || objective.length > resolved.specChars)) {
    return 'l2'
  }
  if (reachesSpec(signals, resolved) || objective.length > resolved.specChars) return 'l2'
  if (level === 'l1' || design) return 'l1'
  return 'l0'
}

/** Capability-owned timeout reason code for the grading call. */
export const DELIVERY_GRADING_TIMEOUT_CODE = 'DELIVERY_GRADING_TIMEOUT'
/** End-to-end deadline for one grading call. */
const GRADING_TIMEOUT_MS = 30_000

/** Output-token cap for one grading call: the answer is a single tier label. */
const GRADING_MAX_OUTPUT_TOKENS = 16

/** Log-only record of one grading request, which is a model call of its own. */
interface DeliveryGradingRequestEventData {
  /** Exact tier rules sent as the grading system prompt. */
  readonly system: string
  /** Exact user message carrying the request text. */
  readonly messages: readonly UserMessage[]
  /** Exact auxiliary route the call used. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Exact output-token cap. */
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one delivery grading model request. */
    'delivery/grading-request': DeliveryGradingRequestEventData
  }
}

/**
 * The route one grading call should use, or `undefined` when none is known.
 *
 * Preference order puts an explicitly configured lightweight route first, then
 * the route the conversation is already using, then the agent's own options:
 * grading is an auxiliary classification, so a deployment that named a cheap
 * model for auxiliary work should get that model rather than the main one.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @returns provider and model, or `undefined` when no route is configured.
 */
function gradingRoute(ctx: Context, agent: Agent): { provider: string; model: string } | undefined {
  const lightweight = ctx.get('lightweightModel')?.currentSelection()
  if (lightweight !== undefined && lightweight.provider.length > 0 && lightweight.model.length > 0) {
    return { provider: lightweight.provider, model: lightweight.model }
  }
  const header = agent.session.requestHeader()?.config
  if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
    return { provider: header.provider, model: header.model }
  }
  const own = agent.options
  if (own.provider !== undefined && own.provider.length > 0
    && own.model !== undefined && own.model.length > 0) {
    return { provider: own.provider, model: own.model }
  }
  return undefined
}

/** The outcome of one grading attempt. */
type GradingOutcome =
  | { readonly kind: 'graded'; readonly level: DeliveryLevel; readonly detail: string }
  | { readonly kind: 'fallback'; readonly level: 'l1'; readonly detail: string }

/**
 * Classify one request by asking a model, with a deterministic fallback.
 *
 * Text matching cannot decide this: it cannot tell "fix a comment in auth.ts"
 * from "change the auth protocol", so every keyword vocabulary both under- and
 * over-matched. The rules therefore live in the editable `gradingPrompt` and
 * the judgement is a model call.
 *
 * Every failure — no route, an abort, a provider error, or a response naming no
 * tier — falls back to `l1` rather than `l0`. A request whose grade could not be
 * determined still gets the discipline: falling back to `l0` would let an
 * infrastructure failure become a discipline gap, while `l1` costs only a
 * design record.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param objective - direct human request text.
 * @param prompt - the configured tier rules.
 * @param signal - turn cancellation signal.
 * @returns the graded level and why, never throwing.
 */
async function gradeWithModel(
  ctx: Context,
  agent: Agent,
  objective: string,
  prompt: string,
  signal: AbortSignal,
): Promise<GradingOutcome> {
  const route = gradingRoute(ctx, agent)
  if (route === undefined) {
    return { kind: 'fallback', level: 'l1', detail: 'no provider/model route is available for grading' }
  }
  const message = createUserMessage({
    content: [{ type: 'text', text: objective }],
    source: { kind: 'plugin', plugin: 'tool-delivery', form: 'notice', summary: 'delivery grading request' },
  })
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [message],
    system: prompt,
    maxTokens: GRADING_MAX_OUTPUT_TOKENS,
    sessionId: agent.session.id,
    purpose: 'session-title',
    signal,
  }
  // The call is model-visible, so the repository rule requires it to be
  // reconstructible from the log; this append happens before dispatch.
  agent.session.append('delivery/grading-request', {
    system: prompt,
    messages: [message],
    route,
    maxTokens: GRADING_MAX_OUTPUT_TOKENS,
  })
  using callDeadline = deadline(signal, GRADING_TIMEOUT_MS, DELIVERY_GRADING_TIMEOUT_CODE)
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of ctx.llm.stream({ ...options, signal: callDeadline.signal })) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'fallback', level: 'l1', detail: `grading call failed: ${detail}` }
  }
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
  const level = parseGradedLevel(text)
  if (level === undefined) {
    return { kind: 'fallback', level: 'l1', detail: `grading response named no tier: ${text.slice(0, 80)}` }
  }
  return { kind: 'graded', level, detail: 'model judgement' }
}

/**
 * Per-agent auto-detect bookkeeping: the pass in flight plus the newest request
 * that arrived while it was running.
 */
interface AutoDetectState {
  /** The running pass, or undefined when this agent has none. */
  running: Promise<void> | undefined
  /**
   * The newest direct request that arrived mid-pass, with its own turn signal.
   * Only the newest is kept: an l0 task is replaced by the NEXT direct request, so
   * carrying an older one forward would grade a request the user has moved past.
   */
  queued: { objective: string; signal: AbortSignal } | undefined
}

/**
 * Start one non-blocking auto-detect pass for a claimed step, if it needs one.
 *
 * The pass runs off the pre-step critical path: the step proceeds immediately
 * and the graded tier lands when the judgement does. That ordering is what keeps
 * a user's own message from waiting on an auxiliary model call, because
 * `user/message` is appended only after the pre-step waterfall resolves.
 *
 * At most one pass per agent runs at a time, so two concurrent passes cannot race
 * for the same task slot; a request arriving mid-pass is remembered and graded by
 * the follow-up pass instead of being dropped, which is what keeps consecutive
 * requests under the discipline.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param objective - direct human request text from the claimed batch.
 * @param signal - the step's cancellation signal.
 * @param lifetime - plugin lifetime, aborted at disposal.
 * @param policy - reads the policy currently in force.
 * @param states - per-agent bookkeeping holding the running and queued passes.
 */
function scheduleAutoDetect(
  ctx: Context,
  agent: Agent,
  objective: string,
  signal: AbortSignal,
  lifetime: AbortSignal,
  policy: () => ResolvedConfig,
  states: Map<string, AutoDetectState>,
): void {
  if (objective.length === 0 || signal.aborted || lifetime.aborted) return
  const key = agent.id
  const state = states.get(key) ?? { running: undefined, queued: undefined }
  states.set(key, state)
  if (state.running !== undefined) {
    state.queued = { objective, signal }
    return
  }
  const start = (goal: string, goalSignal: AbortSignal): Promise<void> =>
    runAutoDetect(ctx, agent, goal, goalSignal, lifetime, policy)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`delivery auto-detect failed: ${message}; continuing the turn`)
      })
  const drain = async (): Promise<void> => {
    let next = { objective, signal }
    while (true) {
      await start(next.objective, next.signal)
      const queued = state.queued
      state.queued = undefined
      if (queued === undefined) break
      next = queued
    }
    state.running = undefined
    states.delete(key)
  }
  state.running = drain()
}

/**
 * Grade one already-claimed request and commit its task.
 *
 * The task is re-read here rather than captured when the pass started: the
 * judgement outlives the step that scheduled it, and during that time the model
 * may have created a task itself or a later request may have replaced the l0
 * one. Creation is therefore decided against the live task, and a task the model
 * owns is left alone.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param objective - direct human request text.
 * @param signal - the scheduling step's cancellation signal.
 * @param lifetime - plugin lifetime, aborted at disposal.
 * @param policy - reads the policy currently in force.
 */
async function runAutoDetect(
  ctx: Context,
  agent: Agent,
  objective: string,
  signal: AbortSignal,
  lifetime: AbortSignal,
  policy: () => ResolvedConfig,
): Promise<void> {
  const current = ctx.delivery.get(agent)
  // A claiming task needs no grading call: an unfinished l1/l2 keeps its claim
  // across turns, so this request runs under it untouched. Everything else (no
  // task, a replaceable l0, or a finished accepted one) starts its own task.
  if (holdsClaim(current)) return
  const floored = gradeByLength(objective, policy().specChars)
  const outcome = floored === undefined
    ? await gradeWithModel(ctx, agent, objective, policy().gradingPrompt, AbortSignal.any([signal, lifetime]))
    : { kind: 'graded' as const, level: floored, detail: 'objective exceeds the length floor' }
  // Cancellation and disposal land after the call, so an aborted session never
  // commits a task for a request the user took back. The grading request itself
  // is already logged, which is what the model-visibility rule requires.
  if (signal.aborted || lifetime.aborted) return
  // Re-read: the judgement outlived the step that scheduled it, and the model may
  // have created or finished a task in the meantime.
  if (holdsClaim(ctx.delivery.get(agent))) return
  // The decision is made before the task is created, so the task starts at its
  // final tier instead of being raised afterwards.
  const created = createReplacingL0(ctx, agent, objective, outcome.level)
  // The rationale is written after the create commits, so a failed artifact
  // write cannot leave a task without its own record.
  await recordGradingRationale(ctx, agent, String(created.id), {
    level: outcome.level,
    decidedBy: floored !== undefined
      ? 'character-floor'
      : outcome.kind === 'fallback' ? 'fallback' : 'model',
    chars: objective.length,
    charFloor: GRADING_CHARACTER_FLOOR,
    detail: outcome.detail,
  })
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

/** Why one task was placed at its level, written into its change artifact. */
interface GradingEvidence {
  /** The final tier. */
  readonly level: DeliveryLevel
  /** Which rule decided it: the length floor, the grading call, or an estimate. */
  readonly decidedBy: 'character-floor' | 'model' | 'estimates' | 'fallback'
  /** Objective length, and the floor it was compared against. */
  readonly chars: number
  readonly charFloor: number
  /** One short line of detail, e.g. the model's own words or the failing call. */
  readonly detail: string
}

/**
 * Record why one task was placed at its level.
 *
 * Written into the task's own change artifact rather than into the task
 * snapshot: that snapshot's decoder rejects unknown fields, and the rationale
 * is a creation-time fact rather than mutable task state. The line names the
 * deciding rule and the evidence behind it, so a reader who disagrees with the
 * tier sees what produced it instead of re-deriving the judgement.
 *
 * A failed write is reported through `ctx.logger` rather than thrown: the task
 * is already committed by the time this runs, so failing the tool call would
 * tell the model its creation failed and leave it retrying a task that exists.
 * The rationale is a trace, not a precondition.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param taskId - created task id, which names the artifact file.
 * @param rationale - the grading evidence.
 */
async function recordGradingRationale(
  ctx: Context,
  agent: Agent,
  taskId: string,
  rationale: GradingEvidence,
): Promise<void> {
  try {
    await appendArtifact(
      ctx,
      agent,
      `.dsh/changes/${taskId}.md`,
      `- graded ${rationale.level} by ${rationale.decidedBy} `
      + `(${rationale.chars} chars vs floor ${rationale.charFloor}; ${rationale.detail})\n`,
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`delivery grading rationale not written for ${taskId}: ${message}`)
  }
}

/** Checkbox regex reused by `renderTasksMarkdown`; matches `[ ]`, `[x]`, `[X]`. */
const TASKS_CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/
/** Trailing `(covers: ...)` or `(覆盖: ...)` annotation preserved on each line. */
const TASKS_COVERS = /\((?:covers|覆盖)\s*:\s*[^)]*\)\s*$/i

/**
 * Strip the trailing `covers:` annotation from one checklist content line.
 *
 * Checklist item content carries its own annotation, because that is where the
 * model declares which verification point the item implements. A line written
 * to `tasks.md` therefore reads `做它 (covers: req/1)`, and comparing it with a
 * rendered item requires both sides to drop the annotation first.
 * @param content - item or line content, with or without an annotation.
 * @returns the content without its trailing annotation, trimmed.
 */
function withoutCovers(content: string): string {
  const trimmed = content.trim()
  const annotation = TASKS_COVERS.exec(trimmed)
  return annotation === null ? trimmed : trimmed.slice(0, annotation.index).trim()
}

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
    const lineContent = withoutCovers(match[2])
    const matchingIdx = items.findIndex(
      (item, idx) => !consumed.has(idx) && withoutCovers(item.content) === lineContent,
    )
    if (matchingIdx < 0) {
      output.push(line)
      continue
    }
    consumed.add(matchingIdx)
    const item = items[matchingIdx] as DeliveryTaskItem
    const done = item.status === 'completed'
    // The model's own annotation wins; an item that declares none keeps the one
    // already on the line. Both halves matter: the scenario and design checks
    // read this file, so a corrected `covers:` list has to reach it, while a
    // checklist re-recorded without annotations must not silently erase the
    // declarations a previous record established.
    const itemAnnotation = TASKS_COVERS.exec(item.content.trim())
    // The annotation keeps the single space that separates it from the content,
    // so a re-recorded item reproduces the line it replaced byte for byte.
    const keptAnnotation = TASKS_COVERS.exec(match[2].trim())?.[0]?.replace(/^\s*/, ' ') ?? ''
    const content = itemAnnotation === null
      ? `${withoutCovers(item.content)}${keptAnnotation}`
      : item.content
    output.push(line.replace(
      /^(\s*[-*]\s+)\[[ xX]\]\s*(.*)$/,
      `$1${done ? '[x]' : '[ ]'} ${content}`,
    ))
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
    const lineContent = withoutCovers(match[2])
    const matchingIdx = items.findIndex(
      (item, idx) => !consumed.has(idx) && withoutCovers(item.content) === lineContent,
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


/**
 * Enforce one gate decision under the policy currently in force.
 *
 * `enforcement` is read per decision rather than only at load: a deployment
 * that turns the gate off from the settings namespace has already registered
 * the tools, so the switch has to take effect where the decision is made. The
 * `stateful`/`advisory` split decides whether the message blocks or only
 * reminds, and `off` makes the gate a no-op.
 * @param exec - running tool execution, used to queue an advisory reminder.
 * @param code - error code a blocking decision carries.
 * @param message - gate message shown to the model.
 * @param policy - reader for the policy currently in force.
 */
function enforceGate(
  exec: ToolRunContext,
  code: string,
  message: string,
  policy: () => ResolvedConfig,
): void {
  const enforcement = policy().enforcement
  if (enforcement === 'off') return
  if (enforcement === 'stateful') throw new HarnessError(message, code)
  exec.deferContext(createUserMessage({
    content: [{ type: 'text', text: `Delivery reminder: ${message}` }],
    source: { kind: 'plugin', plugin: 'tool-delivery', form: 'notice', summary: 'delivery gate' },
  }))
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
  enforceGate(
    exec,
    'DELIVERY_GATE_BLOCKED',
    'requirement analysis is not complete; call mark_analysis_done before writing a design',
    policy,
  )
}

/** Why an l2 task refuses the lightweight todo list. */
const TODO_BLOCKED_REASON = 'this delivery task is l2, so its work is tracked by the OpenSpec checklist '
  + 'instead: write openspec/changes/<change_id>/tasks.md with record_spec(kind: \'tasks\') and report the '
  + 'same checklist with record_tasks. todo_write is disabled while this task is l2.'

/** The settings slice this plugin uses, kept local to avoid a hard dependency. */
interface SettingsSectionHost {
  installSection<T>(
    owner: Context,
    ns: string,
    schema: z<T>,
    entry: T,
    hooks: { setSource(current: () => T): void; onChange(): void },
  ): void
  /** Every registered namespace with its resolved value, for cross-namespace reads. */
  describe(): readonly { ns: string; value: unknown }[]
}

/**
 * The settings provider when one is mounted. Read through `reflect` because
 * `ctx.settings` is declared as always present and its proxy trap rejects
 * access from a plugin that does not inject the service.
 */
function optionalSettings(ctx: Context): SettingsSectionHost | undefined {
  return ctx.reflect.get('settings') as SettingsSectionHost | undefined
}

/** Namespace owning the prompt commands an acceptance command names. */
const PROMPT_COMMANDS_NS = 'prompt-commands'

/** One prompt-command entry as the `prompt-commands` section stores it. */
interface PromptCommandSectionEntry {
  name?: unknown
  title?: unknown
  prompt?: unknown
}

/**
 * The prompt body of each named command, in the order given.
 *
 * Read from the `prompt-commands` section through the shared descriptor rather
 * than from the command registry: the registry exposes UI metadata but not the
 * prompt text, and the section is also what the settings UI edits, so the gate
 * and the editor can never disagree about a command's body. A selected name
 * with no matching entry is reported as such instead of silently dropping out
 * of the requirement — a deployment that deleted a command must see that its
 * acceptance gate lost its body rather than pass without checking.
 * @param ctx - plugin context.
 * @param names - acceptance command names, without the leading slash.
 * @returns one line per name.
 */
function acceptanceBodies(ctx: Context, names: readonly string[]): readonly string[] {
  const settings = optionalSettings(ctx)
  if (settings === undefined) {
    return names.map(name => `/${name}: its prompt is unavailable because this deployment serves no settings provider`)
  }
  const descriptor = settings.describe().find(candidate => candidate.ns === PROMPT_COMMANDS_NS)
  const section = descriptor?.value as { commands?: readonly PromptCommandSectionEntry[] } | undefined
  const entries = new Map<string, PromptCommandSectionEntry>()
  for (const entry of section?.commands ?? []) {
    if (typeof entry.name === 'string') entries.set(entry.name, entry)
  }
  return names.map((name) => {
    const entry = entries.get(name)
    if (entry === undefined) {
      return `/${name}: no command with this name is configured under ${PROMPT_COMMANDS_NS}`
    }
    if (typeof entry.prompt !== 'string' || entry.prompt.trim().length === 0) {
      return `/${name}: its configured prompt is empty`
    }
    return `/${name}: ${entry.prompt.trim()}`
  })
}

/**
 * The gate message naming the next outstanding acceptance command and its prompt.
 *
 * The prompts ride the message rather than a deferred context because
 * `ToolRunContext.deferContext` attaches context only to a SUCCESSFUL result
 * (`packages/core/tools/src/index.ts`), so a blocking throw would discard it.
 * A blocking message is what the model is guaranteed to read, which is where
 * an instruction the model must act on has to live.
 *
 * Only the next command in the configured order is named, and the remaining
 * count is stated, because the configured order is what the gate enforces: a
 * message that listed every outstanding command would leave the model to work
 * out which one comes first.
 * @param ctx - plugin context.
 * @param gap - the next command without a record, with its position.
 * @returns the message shown to the model.
 */
function acceptanceRequirementMessage(ctx: Context, gap: AcceptanceGap): string {
  const body = acceptanceBodies(ctx, [gap.name])[0] ?? `/${gap.name}`
  const remaining = gap.total - gap.position + 1
  const rest = gap.total === 1
    ? ''
    : ` This is acceptance command ${gap.position} of ${gap.total}; `
      + `${remaining - 1} more follow${remaining - 1 === 1 ? 's' : ''} after it.`
  return `delivery verification blocked: acceptance command ${gap.position} of ${gap.total} has no recorded run: `
    + `- ${body}`
    + `${rest} Carry out the prompt above, then record the outcome with record_change using `
    + `"${ACCEPTANCE_RECORD_PREFIX}${gap.name}: <what you found>" so the task can be verified. `
    + 'The gate reads those records, not a summary, and it requires them in the configured order.'
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
    // Auto-detect runs off the pre-step critical path. A graded tier is not
    // model-visible content, while `user/message` is appended only after this
    // waterfall resolves — so holding the step for the grading call would keep
    // the user's own message off the transcript for the call's whole duration.
    const lifetime = new AbortController()
    ctx.effect(() => () => { lifetime.abort(new Error('tool-delivery disposed')) }, 'tool-delivery: auto-detect')
    const states = new Map<string, AutoDetectState>()
    ctx.on('agent/pre-step', ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        scheduleAutoDetect(ctx, agent, directHumanText(messages), signal, lifetime.signal, policy, states)
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
    async execute(args, exec) {
      const agent = deliveryAgent(ctx, exec)
      const signals: SizeSignals = {
        todoCount: typeof args.todo_count === 'number' && Number.isSafeInteger(args.todo_count) ? args.todo_count : 0,
        touchedFiles: typeof args.touched_files === 'number' && Number.isSafeInteger(args.touched_files) ? args.touched_files : 0,
        isBug: args.is_bug === true,
      }
      // An omitted level is graded rather than defaulted: the length floor is
      // settled first, then the model judge, and only then the size estimates
      // the caller supplied — which may raise the tier but never lower it.
      const floored = gradeByLength(args.objective, policy().specChars)
      const outcome = floored === undefined && args.level === undefined
        ? await gradeWithModel(ctx, agent, args.objective, policy().gradingPrompt, exec.signal)
        : undefined
      const base = args.level ?? floored ?? outcome?.level ?? 'l1'
      const level = raiseByEstimates(base, args.objective, signals, policy())
      const view = createReplacingL0(ctx, agent, args.objective, level)
      // A level the model stated explicitly is its own decision, not a graded
      // one, so only the graded path has a rationale to record.
      if (args.level === undefined) {
        await recordGradingRationale(ctx, agent, String(view.id), {
          level,
          decidedBy: floored !== undefined
            ? 'character-floor'
            : outcome === undefined || outcome.kind === 'fallback' ? 'fallback' : 'model',
          chars: args.objective.length,
          charFloor: GRADING_CHARACTER_FLOOR,
          detail: level === base
            ? (outcome?.detail ?? 'no grading was needed')
            : `raised to ${level} by the supplied size estimates`,
        })
      }
      return deliveryValue(view)
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
      + 'name each delta requirement with a `### Requirement: <name>` heading, because that heading plus the '
      + '`#### Scenario:` names are the verification points a checklist must claim. '
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
      + 'that file. Verification requires every point of the original request and of the design documents to '
      + 'be claimed by a COMPLETED item, so end each item\'s content with a trailing annotation: '
      + '"<the work> (covers: req/1, design/D2)" — `req/<n>` for the n-th numbered item of the original '
      + 'request, `design/<Dn>` for each `### D<n>` design heading, and `<capability>/<Scenario name>` for '
      + 'each `#### Scenario:` in the l2 change\'s spec delta. An unannotated item covers nothing, so a '
      + 'checklist without annotations cannot reach verified.',
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
          enforceGate(exec, 'DELIVERY_GATE_BLOCKED', mismatch, policy)
        }
      }
      if (args.phase === 'verified') {
        const confirmation = typeof args.coverage_confirmation === 'string'
          ? args.coverage_confirmation.trim()
          : ''
        // Four checks run here, against the request, the checklist, and the
        // design documents. Only the coverage checks may be released by a
        // specific confirmation within the review budget; the checklist and
        // command checks are deterministic and a confirmation cannot waive
        // them, so a task never verifies on the model's word alone.
        const checklist = await checklistGap(ctx, agent)
        if (checklist !== undefined) {
          enforceGate(
            exec,
            'DELIVERY_GATE_BLOCKED',
            `delivery verification blocked: ${checklist}`,
            policy,
          )
        }
        const commandFailure = await verificationCommandFailure(ctx, agent)
        if (commandFailure !== undefined) {
          enforceGate(
            exec,
            'DELIVERY_STRUCTURAL_VALIDATION_FAILED',
            `delivery verification blocked: ${commandFailure}`,
            policy,
          )
        }
        // The configured acceptance commands are prompt text the model carries
        // out, so they have no exit code to read. The checkable fact is whether
        // the task recorded running each one, and the configured order is
        // enforced by requiring them one at a time from the front.
        const acceptance = acceptanceGap(agent, policy().verificationCommands)
        if (acceptance !== undefined) {
          enforceGate(
            exec,
            'DELIVERY_GATE_BLOCKED',
            acceptanceRequirementMessage(ctx, acceptance),
            policy,
          )
        }
        const gaps = [
          await coverageGap(ctx, agent),
          await requirementCoverageGap(ctx, agent),
        ].filter((gap): gap is string => gap !== undefined)
        if (gaps.length > 0) {
          const rounds = reviewRoundsSpent(agent)
          const specific = confirmation.length >= MIN_CONFIRMATION_CHARS
          if (specific && rounds < policy().maxReviewRounds) {
            // A specific confirmation releases the coverage gap and is
            // recorded, so a later reader sees who reviewed what rather than a
            // silent pass.
            const view = ctx.delivery.recordChange(agent, ref, `${COVERAGE_REVIEW_PREFIX}${confirmation}`)
            await appendArtifact(
              ctx,
              agent,
              `.dsh/changes/${view.id}.md`,
              `- [revision ${view.revision}] ${COVERAGE_REVIEW_PREFIX}${confirmation}\n`,
            )
            ref = { id: view.id, revision: view.revision }
          } else {
            enforceGate(
              exec,
              'DELIVERY_GATE_BLOCKED',
              `delivery coverage gap: ${gaps.join('; ')}. Resolve it by completing the uncovered work and `
              + 'anchoring each point with a `(covers: <key>)` annotation on a completed checklist item, or '
              + `confirm each gap specifically with coverage_confirmation (${rounds}/${policy().maxReviewRounds} `
              + 'review rounds already used); a bare "done" is not accepted.',
              policy,
            )
          }
        }
      }
      const gate = gateAdvance(current, args.phase)
      if (gate !== undefined) {
        enforceGate(exec, 'DELIVERY_GATE_BLOCKED', gate, policy)
      }
      const needsCoverage = args.phase === 'accepted' && current !== undefined
        && (current.designCount > 0 || current.specCount > 0)
      const confirmation = needsCoverage
        ? (typeof args.coverage_confirmation === 'string' ? args.coverage_confirmation.trim() : '')
        : ''
      if (needsCoverage && confirmation.length === 0) {
        enforceGate(
          exec,
          'DELIVERY_GATE_BLOCKED',
          'at least one design or spec record is unconfirmed; provide coverage_confirmation stating each was implemented',
          policy,
        )
      }
      // The verification commands run at `verified`, the phase that claims the
      // work was verified; acceptance only records the outcome, so a passing
      // task is not held to a second run of the same commands.
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
