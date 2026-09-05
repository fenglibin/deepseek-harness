/**
 * Model-facing result rendering for the bash tool.
 *
 * @module @deepseek-ai/dsh-tool-bash/render
 */

import type { ShellProcessRead, ShellRunResult, ShellSandboxInfo, CollectedOutput } from '@deepseek-ai/dsh-shell'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * A `sleep` operand: a bare seconds count, which is the form the pattern this
 * hint targets actually uses. GNU `sleep` suffixes (`1m`, `2h`) are not parsed,
 * so a suffixed wait is a missed hint rather than a wrong one.
 */
const SLEEP_SECONDS = /\bsleep\s+(\d+(?:\.\d+)?)/g

/** Shortest fixed wait worth replacing with an event-driven wait, in seconds. */
const SLEEP_HINT_SECONDS = 30

/** A command whose first word is a shell search the `fs_search` tool replaces. */
const SHELL_SEARCH = /^(?:grep|find)\b/

/** Whole-repository test invocations: `pnpm [run] test…` and `npx vitest run`. */
const REPO_WIDE_TEST = /\bpnpm\s+(?:run\s+)?test\S*|\bnpx\s+vitest\s+run\b/

/** A token that scopes a run to a path or a file, so the run is no longer repo-wide. */
const TEST_SCOPE = /\/|\.(?:ts|tsx|js|mjs|cjs|py)$/

const SLEEP_HINT = '[hint: to wait on a background job, call job_output with wait: true and timeout_ms; '
  + 'it returns the moment the job settles, instead of sleeping a fixed duration]'

const SEARCH_HINT = '[hint: code search through the fs_search tool is structured and avoids shell quoting; '
  + 'prefer it over grep/find for locating code]'

const REPO_TEST_HINT = '[hint: this runs the whole repository suite (measured ~143 s for 17,429 tests); '
  + 'scope it to the affected packages — see docs/testing.zh.md]'

/**
 * Drop one leading `cd <path> &&`, which is how a model wraps most commands
 * even though every call already starts in the session workspace.
 * @param command - the exact command the model sent.
 * @returns the command without that prefix, unchanged when it is absent.
 */
function stripLeadingCd(command: string): string {
  return command.replace(/^\s*cd\s+\S+\s*&&\s*/, '')
}

/**
 * Detect a fixed wait long enough to be worth replacing with `job_output`'s
 * event-driven wait, which settles the moment the job does.
 * @param command - the command with any `cd` prefix stripped.
 * @returns whether it sleeps at least {@link SLEEP_HINT_SECONDS} seconds.
 */
function waitsBySleep(command: string): boolean {
  for (const match of command.matchAll(SLEEP_SECONDS)) {
    if (Number(match[1]) >= SLEEP_HINT_SECONDS) return true
  }
  return false
}

/**
 * Detect an unscoped verification run, which sweeps the whole repository
 * instead of the packages the change touched.
 * @param command - the command with any `cd` prefix stripped.
 * @returns whether it invokes the suite, or coverage, without a path or file scope.
 */
function runsWholeRepoSuite(command: string): boolean {
  if (command.split(/\s+/).some(token => TEST_SCOPE.test(token))) return false
  return command.includes('--coverage') || REPO_WIDE_TEST.test(command)
}

/**
 * Runtime hints that steer the model toward capabilities the harness already
 * offers, each fired by the call that exhibits the pattern it names — guidance
 * stated once in the system prompt does not move behavior at the moment of
 * action. Triggers are deliberately narrow: roughly a quarter of measured
 * commands match, and a hint that fires on ordinary commands is noise the
 * model learns to skip.
 * @param command - the exact command the model sent.
 * @returns the hints the command triggers, in trigger order; empty when it triggers none.
 */
export function efficiencyHints(command: string): readonly string[] {
  const stripped = stripLeadingCd(command)
  const hints: string[] = []
  if (waitsBySleep(stripped)) hints.push(SLEEP_HINT)
  if (SHELL_SEARCH.test(stripped)) hints.push(SEARCH_HINT)
  if (runsWholeRepoSuite(stripped)) hints.push(REPO_TEST_HINT)
  return hints
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers. Non-zero exits are reported, not
 * errored — the model decides how to react; only infrastructure failures
 * (spawn errors, aborts) surface as isError results.
 * @param result - the completed foreground run from the executor.
 * @param escalationModes - the escalation targets this composition advertises;
 *   non-empty adds the same-turn escalation hint after a denial marker
 *   (default `[]`: no hint).
 * @param command - the command that produced this result, which
 *   {@link efficiencyHints} matches (default `''`: no hints).
 * @returns the model-facing text: output body (or `(no output)`), then hints, then timeout/signal/exit markers, one per line.
 */
export function renderResult(
  result: ShellRunResult,
  escalationModes: readonly SandboxMode[] = [],
  command = '',
): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)

  let body = out
  if (err.length > 0) {
    // Single newline between sections (stdout usually ends with one already).
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers: string[] = []
  // Keep the exit marker last because parseExitStatus anchors there.
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    // Hint only when the composition exposes escalation, before the final exit marker.
    if (escalationModes.length > 0) {
      markers.push(escalationHintMarker('command'))
    }
  }
  // Hints join before the exit block: the exit marker must stay last.
  markers.push(...efficiencyHints(command))
  // A command may trap SIGTERM and exit 0 after timeout; still report interruption.
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Shape one background-process read into the `job_output` delta the model
 * sees: the incremental delta, plus the lossy-read notice (with full-stream
 * spill paths) when in-memory truncation dropped unread bytes. Empty-delta
 * rendering (`(no new output)`) is the generic job controller's job.
 * @param read - one incremental read from the process handle.
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the delta text with any loss or sandbox notice appended.
 */
export function renderProcessRead(
  read: ShellProcessRead,
  sandbox?: ShellSandboxInfo,
  escalationModes: readonly SandboxMode[] = [],
): string {
  const notices: string[] = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path): path is string => path !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) {
    notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) {
      notices.push(escalationHintMarker('command'))
    }
  }
  if (notices.length === 0) return read.delta
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

/**
 * The exit-status parse is the shared marker-contract half of the shell-tool
 * rendering story, owned by `@deepseek-ai/dsh-shell` so `dsh-tool-pwsh` reuses
 * it (its renderer emits the same markers). Re-exported here to keep
 * `../src/render.ts` a single import root for bash-tool consumers.
 */
export { parseExitStatus, type ParsedExitStatus } from '@deepseek-ai/dsh-shell'
