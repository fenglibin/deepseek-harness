/**
 * Local verification scope. A one-package edit costs seconds to verify, while
 * the full suite costs 143 seconds; this script computes the packages a change
 * touches plus their direct workspace dependents and runs only those tests.
 * CI keeps owning the full suite and `test:coverage`. The tiering rule lives in
 * docs/testing.md, and the latency profile that motivated it lives in
 * docs/design/agent-task-latency.md.
 *
 * @module @deepseek-ai/dsh-root/verify-changed
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/** One workspace package: its published name and its repository directory. */
export interface WorkspacePackage {
  /** Published package name, such as `@deepseek-ai/dsh-session-controller`. */
  readonly name: string
  /** Directory relative to the repository root, such as `packages/api/session-controller`. */
  readonly dir: string
}

/** Every workspace package's direct workspace dependency names, keyed by directory. */
export type PackageDependencyMap = ReadonlyMap<string, readonly string[]>

/** Inputs for one affected-package computation; every field is injectable so the scope rule stays testable. */
export interface AffectedInput {
  /** Repository-root-relative paths reported by git. */
  readonly changedFiles: readonly string[]
  /** Every discovered workspace package. */
  readonly packages: readonly WorkspacePackage[]
  /** Direct workspace dependency names keyed by package directory. */
  readonly dependencies: PackageDependencyMap
}

/** Globs locating workspace package manifests. Vendored packages carry their own suites and stay out of scope. */
export const WORKSPACE_MANIFEST_GLOBS: readonly string[] = ['packages/*/*/package.json', 'apps/*/package.json']

/** Name prefix shared by every workspace package, used to keep external dependencies out of the scope. */
export const WORKSPACE_DEPENDENCY_PREFIX = '@deepseek-ai/dsh-'

/** Depth of a `packages/<group>/<pkg>` directory, counted in path segments. */
const PACKAGE_DIR_SEGMENTS = 3

/** Depth of an `apps/<app>` directory, counted in path segments. */
const APP_DIR_SEGMENTS = 2

/** Report nothing to run rather than falling back to the full suite, which is CI's job. */
const NO_SCOPE_EXIT_CODE = 0

/**
 * Reduce one changed path to the workspace directory that owns its tests.
 * @param filePath - repository-root-relative path reported by git.
 * @returns the owning `packages/<group>/<pkg>` or `apps/<app>` directory, or `undefined` when no workspace directory owns it.
 */
export function owningDirectory(filePath: string): string | undefined {
  const segments = filePath.split('/')
  if (segments[0] === 'packages' && segments.length >= PACKAGE_DIR_SEGMENTS) {
    return segments.slice(0, PACKAGE_DIR_SEGMENTS).join(sep)
  }
  if (segments[0] === 'apps' && segments.length >= APP_DIR_SEGMENTS) {
    return segments.slice(0, APP_DIR_SEGMENTS).join(sep)
  }
  return undefined
}

/**
 * Compute the directories that own the changed files, ignoring dependents.
 * @param input - changed paths, discovered packages, and their direct dependencies.
 * @returns sorted, de-duplicated repository-root-relative directories.
 */
export function changedDirectories(input: AffectedInput): readonly string[] {
  const selected = new Set<string>()
  for (const filePath of input.changedFiles) {
    const owner = owningDirectory(filePath)
    if (owner === undefined) continue
    selected.add(owner)
  }
  return [...selected].sort()
}

/**
 * Compute the directories whose tests a change can affect: every changed
 * package, plus each workspace package that depends on it directly at runtime.
 * Dependents are expanded against a snapshot of the changed set, never against
 * the growing result, so expansion is exactly one level and independent of map
 * iteration order.
 * @param input - changed paths, discovered packages, and their direct dependencies.
 * @returns sorted, de-duplicated repository-root-relative directories.
 */
export function affectedDirectories(input: AffectedInput): readonly string[] {
  const byName = new Map(input.packages.map(entry => [entry.name, entry.dir]))
  const changed = new Set(changedDirectories(input))
  const selected = new Set(changed)
  for (const [dependent, dependencyNames] of input.dependencies) {
    for (const dependencyName of dependencyNames) {
      const dependencyDir = byName.get(dependencyName)
      if (dependencyDir !== undefined && changed.has(dependencyDir)) {
        selected.add(dependent)
      }
    }
  }
  return [...selected].sort()
}

/**
 * Read every workspace package manifest and its direct workspace dependencies.
 * Manifests are visited in sorted order, so the reported scope never depends on
 * the order the filesystem happens to return.
 * @param root - absolute repository root.
 * @returns discovered packages and their direct workspace dependency names keyed by directory.
 * @throws when a manifest is missing its name or cannot be parsed.
 */
export function readWorkspacePackages(root: string): {
  readonly packages: readonly WorkspacePackage[]
  readonly dependencies: PackageDependencyMap
} {
  const packages: WorkspacePackage[] = []
  const dependencies: Map<string, readonly string[]> = new Map()
  const manifests = WORKSPACE_MANIFEST_GLOBS
    .flatMap(pattern => globSync(pattern, { cwd: root }))
    .sort()
  for (const manifest of manifests) {
    const dir = dirname(manifest)
    const parsed = readManifest(root, manifest)
    packages.push({ name: parsed.name, dir })
    dependencies.set(dir, parsed.dependencies)
  }
  return { packages, dependencies }
}

/**
 * Parse one manifest into its name and its direct runtime dependency names.
 * Only `dependencies` participates: a `devDependencies` entry is a build- or
 * test-time relationship, so treating it as a runtime edge would spread one
 * package's change across most of the workspace.
 */
function readManifest(root: string, manifest: string): { readonly name: string; readonly dependencies: readonly string[] } {
  const absolute = resolve(root, manifest)
  let raw: string
  try {
    raw = readFileSync(absolute, 'utf8')
  } catch (error) {
    throw new Error(`verify-changed: cannot read ${manifest}: ${String(error)}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`verify-changed: ${manifest} is not valid JSON: ${String(error)}`, { cause: error })
  }
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error(`verify-changed: ${manifest} has no non-empty "name"`)
  }
  const names = new Set<string>()
  const runtimeDependencies = parsed.dependencies
  if (isRecord(runtimeDependencies)) {
    for (const name of Object.keys(runtimeDependencies)) {
      if (name.startsWith(WORKSPACE_DEPENDENCY_PREFIX)) names.add(name)
    }
  }
  return { name: parsed.name, dependencies: [...names].sort() }
}

/**
 * Ask git which paths changed.
 * `git diff --name-only <revision>` reports staged and unstaged edits, but a
 * brand-new file the agent just wrote is untracked and absent from that diff,
 * so untracked paths are folded in from `git ls-files --others --exclude-standard`
 * to keep a newly created package or test from silently falling out of scope.
 * @param root - absolute repository root.
 * @param revision - revision to diff against; `HEAD` covers staged and unstaged worktree changes.
 * @returns sorted, de-duplicated repository-root-relative paths.
 * @throws when git is unavailable or either query fails.
 */
export function changedPaths(root: string, revision = 'HEAD'): readonly string[] {
  const edited = runGit(root, ['diff', '--name-only', revision], `git diff --name-only ${revision}`)
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard'], 'git ls-files --others --exclude-standard')
  return [...new Set([...edited, ...untracked])].sort()
}

/** Run one git query and return its non-empty output lines. */
function runGit(root: string, args: readonly string[], display: string): readonly string[] {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) {
    throw new Error(`verify-changed: cannot run git: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(`verify-changed: ${display} failed with status ${String(result.status)}: ${result.stderr.trim()}`)
  }
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/**
 * Run one verification command and report its exit code.
 * @param directories - repository-root-relative directories to verify.
 * @param root - absolute repository root.
 * @returns the child process exit code.
 */
export type TestRunner = (directories: readonly string[], root: string) => number

/**
 * Run the tests for the affected directories through vitest.
 * @param directories - repository-root-relative directories to verify.
 * @param root - absolute repository root.
 * @returns the child process exit code.
 * @throws when vitest cannot be spawned.
 */
export const spawnVitest: TestRunner = (directories, root) => {
  const result = spawnSync('npx', ['vitest', 'run', ...directories], { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) {
    throw new Error(`verify-changed: cannot run vitest: ${result.error.message}`, { cause: result.error })
  }
  /* v8 ignore next -- status is null only when a signal kills the child, which a unit test cannot produce deterministically. */
  return result.status ?? 1
}

/**
 * Run the tests for the affected directories, skipping when nothing is in scope.
 * @param directories - repository-root-relative directories to verify.
 * @param root - absolute repository root.
 * @param run - command executor; defaults to spawning vitest.
 * @returns the child process exit code, or 0 when nothing is in scope.
 */
export function runTests(
  directories: readonly string[],
  root: string,
  run: TestRunner = spawnVitest,
): number {
  if (directories.length === 0) {
    console.log('verify-changed: no workspace package is in scope; skipping (the full suite belongs to CI).')
    return NO_SCOPE_EXIT_CODE
  }
  console.log(`verify-changed: running ${directories.length} package scope(s): ${directories.join(' ')}`)
  return run(directories, root)
}

/** Narrow an unknown JSON value to a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Entry point: `--list` prints the scope instead of running it, and
 * `--direct-only` drops dependent packages for a change whose blast radius the
 * caller already knows. Without flags, the scope's tests run.
 * @param argv - command-line arguments after the script path.
 * @param root - absolute repository root; defaults to this script's repository.
 * @param run - command executor; defaults to spawning vitest.
 * @returns the process exit code.
 */
export function main(
  argv: readonly string[],
  root = resolve(import.meta.dirname, '..'),
  run: TestRunner = spawnVitest,
): number {
  const listOnly = argv.includes('--list')
  const { packages, dependencies } = readWorkspacePackages(root)
  const input = { changedFiles: changedPaths(root), packages, dependencies }
  const directories = argv.includes('--direct-only') ? changedDirectories(input) : affectedDirectories(input)
  if (listOnly) {
    for (const directory of directories) console.log(directory)
    return 0
  }
  return runTests(directories, root, run)
}

/* v8 ignore start -- the CLI entry runs only as a process, never under test. */
if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2))
}
/* v8 ignore stop */
