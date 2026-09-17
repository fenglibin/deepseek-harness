/**
 * Implementation verification: the checks a task must pass before it may reach
 * `verified`. Split out of the plugin entry so the four checks and their
 * coverage helpers read as one unit rather than as part of the tool registry.
 * @module @deepseek-ai/dsh-tool-delivery/verification
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isValidChangeId } from './openspec.ts'
import {
  coverageReport,
  coversOf,
  describeCoverageGap,
  designPoints,
  hasCoverageGap,
  parseChecklist,
  requirementPoints,
  scenarioPoints,
} from './coverage.ts'
import type { CoveragePoint } from './coverage.ts'

/**
 * Review rounds already spent by one exact task.
 *
 * Counted from the session log rather than a process-level map: the log is
 * what survives a resume, a fork, or a second session in the same process, and
 * a shared counter let one session consume another's review budget.
 *
 * The count is also scoped to the task id, because a session that clears a
 * task and starts another would otherwise inherit every round the previous one
 * spent and begin with no review budget at all.
 * @param agent - owning live agent.
 * @returns how many coverage reviews this task has already recorded.
 */
export function reviewRoundsSpent(agent: Agent): number {
  const current = currentTaskIdFromLog(agent)
  if (current === undefined) return 0
  let rounds = 0
  for (const event of agent.session.events) {
    if (event.type !== 'delivery/change') continue
    const change = event.data as { operation?: unknown; text?: unknown; ref?: { id?: unknown } }
    if (change.operation !== 'record-change') continue
    if (change.ref?.id !== current) continue
    if (typeof change.text === 'string' && change.text.startsWith(COVERAGE_REVIEW_PREFIX)) rounds += 1
  }
  return rounds
}

/**
 * The id of the task the agent currently holds, read from the log.
 *
 * Read from the log rather than the service so this stays a pure function of
 * the events being counted, and so it needs no live service handle.
 * @param agent - owning live agent.
 * @returns the current task id, or undefined when no task is current.
 */
function currentTaskIdFromLog(agent: Agent): string | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type !== 'delivery/change') continue
    const change = event.data as {
      operation?: unknown
      task?: { id?: unknown }
      cleared?: { id?: unknown }
      ref?: { id?: unknown }
    }
    if (change.operation === 'clear') return undefined
    if (change.operation === 'create' || change.operation === 'advance') {
      return typeof change.task?.id === 'string' ? change.task.id : undefined
    }
  }
  return undefined
}

/** Record-text prefix marking one review round, used to count them back. */
export const COVERAGE_REVIEW_PREFIX = 'coverage review: '

/** Shortest confirmation that is specific enough to release a coverage gap. */
export const MIN_CONFIRMATION_CHARS = 20

/**
 * Unfinished and unanchored items of the agent's authoritative checklist.
 *
 * The authority differs by tier: an `l2` task is checked against the OpenSpec
 * `tasks.md` on disk, while `l0`/`l1` are checked against the recorded
 * `delivery-tasks` write. An `l1` task with no checklist at all is a gap, not
 * a pass — the previous implementation returned early on `undefined`, so an
 * unrecorded task verified without any evidence. An `l0` task is a small fix
 * whose discipline is the request alone, so it has no checklist obligation and
 * is checked only when it recorded one.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @returns a description of the gap, or `undefined` when every item is complete.
 */
export async function checklistGap(ctx: Context, agent: Agent): Promise<string | undefined> {
  const recorded = ctx.delivery.getTasks(agent)
  const current = ctx.delivery.get(agent)
  if (recorded === undefined) {
    if (current !== undefined && current.level === 'l0') return undefined
    return 'no implementation checklist is recorded; call record_tasks before verifying'
  }
  if (current !== undefined && current.level === 'l2') {
    // The disk checklist is what OpenSpec reads, so a recorded checklist that
    // only claims completion is a mismatch rather than a pass.
    const mismatch = await checklistMismatch(ctx, agent)
    if (mismatch !== undefined) return mismatch
  }
  const unfinished = recorded.items.filter(item => item.status !== 'completed')
  if (unfinished.length === 0) return undefined
  const listed = unfinished.slice(0, 5).map(item => item.content).join('; ')
  const more = unfinished.length > 5 ? ` (+${unfinished.length - 5} more)` : ''
  return `${unfinished.length} unfinished checklist item(s): ${listed}${more}`
}

/**
 * Coverage of the original request, the design, and the delta specs by the
 * authoritative checklist.
 *
 * Requirement points come from the request's own numbered list, so each stated
 * demand must be claimed by a completed item instead of being released by one
 * free-text confirmation. A request with no numbered list contributes no
 * requirement points, and an `l2` change additionally contributes its
 * scenario and design-decision points.
 *
 * An `l0` task is exempt from annotation coverage: it owes no checklist, so
 * there is nothing that could carry a `(covers: ...)` annotation, and holding
 * it to one would block every small fix whose request happens to be written as
 * a numbered list. Its discipline is the request itself plus the confirmation
 * the verified phase already requires — the same evidence the tier is defined
 * by.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @returns a description of the uncovered points, or `undefined` when covered.
 */
export async function requirementCoverageGap(ctx: Context, agent: Agent): Promise<string | undefined> {
  const current = ctx.delivery.get(agent)
  if (current === undefined) return undefined
  if (current.level === 'l0') return undefined
  const recorded = ctx.delivery.getTasks(agent)
  const points: CoveragePoint[] = [...requirementPoints(current.objective)]
  // Design decisions are declared in the task's own design record and, for an
  // l2 change, in the OpenSpec design.md; both are read here.
  const designPath = `.dsh/design/${String(current.id)}.md`
  const design = await readWorkspaceText(ctx, agent, designPath)
  if (design !== undefined) points.push(...designPoints(design))
  if (recorded !== undefined && isValidChangeId(recorded.changeId)) {
    const changeId = recorded.changeId
    const spec = await readWorkspaceText(ctx, agent, `openspec/changes/${changeId}/design.md`)
    if (spec !== undefined) points.push(...designPoints(spec))
  }
  if (points.length === 0) return undefined
  // Only completed items count as coverage: an item still in progress has not
  // implemented the point it claims.
  const items = (recorded?.items ?? []).map(item => ({
    content: item.content,
    done: item.status === 'completed',
    covers: coversOf(item.content),
  }))
  const report = coverageReport(points, items)
  const uncovered = report.uncovered.filter((key) => {
    const point = points.find(candidate => candidate.key === key)
    return point !== undefined && point.source === 'requirement'
  })
  const uncoveredDesign = report.uncovered.filter(key => !uncovered.includes(key))
  const lines: string[] = []
  if (uncovered.length > 0) {
    lines.push(`uncovered request items: ${uncovered.join(', ')}`)
  }
  if (uncoveredDesign.length > 0) {
    lines.push(`uncovered design decisions: ${uncoveredDesign.join(', ')}`)
  }
  if (lines.length === 0) return undefined
  return `${lines.join('; ')}. Anchor each with a \`(covers: <key>)\` annotation on a completed item.`
}

/**
 * Read one workspace-relative file, or `undefined` when it is absent.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param path - workspace-relative path.
 * @returns the file body, or `undefined` when it cannot be read.
 */
async function readWorkspaceText(ctx: Context, agent: Agent, path: string): Promise<string | undefined> {
  const cwd = agent.session.header.cwd
  try {
    const target = cwd === undefined
      ? await ctx.fs.resolve(path)
      : await ctx.fs.resolve(path, { cwd })
    return await ctx.fs.readText(target)
  } catch {
    return undefined
  }
}

/**
 * List the capability directories one change declares delta specs for.
 *
 * The directories are read from disk instead of from `openspec show --json`,
 * which refuses a change whose proposal.md uses non-English section headings.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param changeId - verb-led kebab-case change id.
 * @returns kebab-case capability names; empty when the change declares none.
 */
async function discoverCapabilities(ctx: Context, agent: Agent, changeId: string): Promise<readonly string[]> {
  const cwd = agent.session.header.cwd
  const path = `openspec/changes/${changeId}/specs`
  try {
    const target = cwd === undefined
      ? await ctx.fs.resolve(path)
      : await ctx.fs.resolve(path, { cwd })
    const entries = await ctx.fs.listDir(target)
    return entries
      .filter(entry => entry.type === 'directory')
      .map(entry => entry.name)
      .filter(name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
  } catch {
    // A change with no delta specs has no scenario points to cover; the
    // design decisions still contribute their own points.
    return []
  }
}

/**
 * Run the structural verification command and report its failure.
 *
 * This runs at `verified` rather than at `accepted`: the phase that claims the
 * work was verified is the phase that has to prove it, and a failure found
 * only at acceptance has already let the task report itself as verified. An
 * `l2` task validates its own change id so unrelated legacy changes under
 * `openspec/changes/` cannot block it. A task with no OpenSpec change has no
 * structural artifact to validate and runs nothing here.
 *
 * The configured acceptance commands are NOT run here: their bodies are prompt
 * text the model carries out, so they have no exit code to read. They are
 * checked as records by {@link acceptanceGap}.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @returns a failure description, or `undefined` when the command passed or
 * none applies.
 */
export async function verificationCommandFailure(
  ctx: Context,
  agent: Agent,
): Promise<string | undefined> {
  const changeId = ctx.delivery.getTasks(agent)?.changeId
  if (changeId === undefined || !isValidChangeId(changeId)) return undefined
  return runValidation(ctx, agent, [`openspec validate ${changeId} --strict --json`])
}

/** Record-text prefix marking one acceptance command as carried out. */
export const ACCEPTANCE_RECORD_PREFIX = 'acceptance: '

/** The one acceptance command the gate requires next, and its place in the list. */
export interface AcceptanceGap {
  /** Configured name of the command still without a record. */
  readonly name: string
  /** 1-based position of that command in the configured order. */
  readonly position: number
  /** How many commands the configuration lists in total. */
  readonly total: number
}

/**
 * The first configured acceptance command that left no record on this task.
 *
 * A prompt command is not a shell command: it is text the model carries out,
 * so it produces no exit code to gate on. The checkable fact is therefore
 * whether the task recorded that it ran the command. Anchoring on a recorded
 * line rather than on the model's closing prose keeps the gate independent of
 * wording.
 *
 * Only the earliest unrecorded command is reported, so the configured order is
 * a mechanical requirement rather than a presentation detail: the model cannot
 * skip ahead to a later command, and the gate can name the one command that is
 * actually next. Once that command is recorded, the following call reports the
 * next one, so a task clears the list from the front under repeated advances.
 * @param agent - owning live agent.
 * @param names - configured acceptance command names, in execution order.
 * @returns the next outstanding command with its position, or `undefined` when
 * every configured command has a record or none is configured.
 */
export function acceptanceGap(agent: Agent, names: readonly string[]): AcceptanceGap | undefined {
  const current = currentTaskIdFromLog(agent)
  if (current === undefined || names.length === 0) return undefined
  const recorded = new Set<string>()
  for (const event of agent.session.events) {
    if (event.type !== 'delivery/change') continue
    const change = event.data as { operation?: unknown; text?: unknown; ref?: { id?: unknown } }
    if (change.operation !== 'record-change') continue
    if (change.ref?.id !== current) continue
    if (typeof change.text !== 'string') continue
    if (!change.text.startsWith(ACCEPTANCE_RECORD_PREFIX)) continue
    // The name is the first token after the prefix; the rest is the model's
    // own note about what it observed, which the gate does not interpret. A
    // leading slash and a trailing colon are accepted because the model may
    // copy the `/name:` spelling the settings UI shows.
    const body = change.text.slice(ACCEPTANCE_RECORD_PREFIX.length).trim()
    const normalized = (body.split(/\s+/)[0] ?? '').replace(/^\/+/, '').replace(/:$/, '')
    if (normalized.length > 0) recorded.add(normalized)
  }
  for (const [index, name] of names.entries()) {
    if (!recorded.has(name)) return { name, position: index + 1, total: names.length }
  }
  return undefined
}

/**
 * Collect the coverage gaps of the agent's current change: points the delta
 * specs and the design declare that no checklist item claims, and items
 * claiming points that do not exist.
 *
 * Capability directories are discovered on disk rather than through
 * `openspec show --json`. That command refuses a change whose proposal.md does
 * not use its exact English section headings — `## Why`, `## What Changes` —
 * and a Chinese-authoring deployment writes `## 为什么` instead, which is the
 * natural heading for its reader. Relying on the command made every scenario
 * point silently vanish for such a change, because a non-zero exit was treated
 * as "no coverage to check". The delta specs are the same files either way, and
 * `openspec validate` remains the authority for structural validity.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @returns a one-line gap description, or `undefined` when coverage is
 * complete, when no change is recorded, or when the change declares no points.
 */
export async function coverageGap(ctx: Context, agent: Agent): Promise<string | undefined> {
  const recorded = ctx.delivery.getTasks(agent)
  if (recorded === undefined) return undefined
  const changeId = recorded.changeId
  if (!isValidChangeId(changeId)) return undefined
  const read = (path: string): Promise<string | undefined> => readWorkspaceText(ctx, agent, path)
  const points: CoveragePoint[] = []
  for (const capability of await discoverCapabilities(ctx, agent, changeId)) {
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

/**
 * Run the structural validation commands in order and return the first failure.
 *
 * Only commands that produce an exit code reach here: the user-configured
 * acceptance commands are prompt text the model carries out, so they are
 * checked by {@link acceptanceGap} instead.
 * @param ctx - plugin context.
 * @param agent - owning live agent.
 * @param commands - commands to run in the session cwd, in order.
 * @returns the first failure, or `undefined` when every command passed.
 */
async function runValidation(ctx: Context, agent: Agent, commands: readonly string[]): Promise<string | undefined> {
  for (const command of commands) {
    const cwd = agent.session.header.cwd
    const request: { command: string; workdir?: string } = { command }
    if (cwd !== undefined) request.workdir = cwd
    const result = await ctx.shell.run(ctx.shell.resolve(request))
    if (result.exitCode === 0 && !result.timedOut && !result.aborted) continue
    const issues = validationIssues(result.stdout.text)
    const detail = issues.length > 0
      ? issues.join('; ')
      : result.stderr.text.trim() || result.stdout.text.trim()
    return `structural validation "${command}" failed${detail.length > 0 ? `: ${detail}` : ''}`
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
export async function checklistMismatch(ctx: Context, agent: Agent): Promise<string | undefined> {
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
