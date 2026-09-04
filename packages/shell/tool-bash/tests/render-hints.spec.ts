import { describe, expect, it } from 'vitest'
import { efficiencyHints, parseExitStatus, renderResult } from '../src/render.ts'

/** A settled foreground run whose markers the hints must not displace. */
const base = {
  exitCode: 0 as number | null,
  signal: null as NodeJS.Signals | null,
  timedOut: false,
  aborted: false,
  timeoutMs: 1000,
  stdout: { text: '', truncated: false },
  stderr: { text: '', truncated: false },
}

const SLEEP = 'job_output with wait: true'
const SEARCH = 'fs_search tool'
const REPO_TEST = 'whole repository suite'

/** Every hint one command produced, as a single string for substring assertions. */
function hints(command: string): string {
  return efficiencyHints(command).join('\n')
}

describe('efficiencyHints', () => {
  it('fires the event-driven-wait hint on a long fixed sleep', () => {
    expect(hints('sleep 60')).toContain(SLEEP)
    expect(hints('while :; do sleep 300; done')).toContain(SLEEP)
  })

  it('treats the threshold as inclusive and shorter waits as ordinary commands', () => {
    expect(efficiencyHints('sleep 30')).toHaveLength(1)
    expect(efficiencyHints('sleep 29')).toEqual([])
    expect(efficiencyHints('sleep 5')).toEqual([])
    expect(efficiencyHints('sleep 0.5')).toEqual([])
  })

  it('fires the search hint on a leading grep or find', () => {
    expect(hints('grep -rn "foo" packages')).toContain(SEARCH)
    expect(hints('find . -name "*.ts"')).toContain(SEARCH)
  })

  it('stays silent for a piped grep, which filters another command output', () => {
    expect(efficiencyHints('some-command | grep x')).toEqual([])
    expect(efficiencyHints('ls -la')).toEqual([])
    expect(efficiencyHints('grepping')).toEqual([])
  })

  it('fires the repo-suite hint on an unscoped verification run', () => {
    expect(hints('pnpm test')).toContain(REPO_TEST)
    expect(hints('pnpm run test')).toContain(REPO_TEST)
    expect(hints('pnpm run test:coverage')).toContain(REPO_TEST)
    expect(hints('npx vitest run')).toContain(REPO_TEST)
    expect(hints('npx vitest run --coverage')).toContain(REPO_TEST)
  })

  it('stays silent for a verification run scoped to a path', () => {
    expect(efficiencyHints('npx vitest run packages/api')).toEqual([])
    expect(efficiencyHints('pnpm test packages/shell/tool-bash')).toEqual([])
    expect(efficiencyHints('npx vitest run packages/api --coverage')).toEqual([])
    expect(efficiencyHints('npx tsc -b tsconfig.host.json')).toEqual([])
  })

  it('strips one leading cd prefix before matching', () => {
    expect(hints('cd /repo && grep -r foo .')).toContain(SEARCH)
    expect(hints('cd /repo && sleep 240')).toContain(SLEEP)
    expect(hints('cd /repo && pnpm test')).toContain(REPO_TEST)
  })

  it('emits every hint a command triggers and none for an ordinary command', () => {
    expect(efficiencyHints('cd /repo && grep -r foo . && sleep 60')).toHaveLength(2)
    expect(efficiencyHints('echo hello')).toEqual([])
    expect(efficiencyHints('')).toEqual([])
  })
})

describe('renderResult hints', () => {
  it('keeps the exit marker last so the terminal exit pill still parses', () => {
    const rendered = renderResult({ ...base, exitCode: 7 }, [], 'grep -r foo .')
    expect(rendered).toContain(SEARCH)
    expect(rendered.endsWith('\n[exit code: 7]')).toBe(true)
    const parsed = parseExitStatus(rendered)
    expect(parsed).toMatchObject({ exitCode: 7 })
    expect(parsed.body).toContain(SEARCH)
  })

  it('keeps the signal marker last when a hinted command is killed', () => {
    const rendered = renderResult({ ...base, exitCode: null, signal: 'SIGTERM', timedOut: true }, [], 'sleep 60')
    expect(rendered).toContain(SLEEP)
    expect(rendered.endsWith('[killed by signal: SIGTERM]')).toBe(true)
    expect(parseExitStatus(rendered)).toMatchObject({ signal: 'SIGTERM' })
  })

  it('leaves the text unchanged when the command triggers nothing', () => {
    expect(renderResult({ ...base, exitCode: 0 }, [], 'echo hello')).toBe('(no output)')
    expect(renderResult({ ...base, exitCode: 3 })).toBe('(no output)\n[exit code: 3]')
  })
})
