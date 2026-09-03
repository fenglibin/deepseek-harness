/**
 * Tests for the local verification scope: directory ownership, dependent
 * expansion, manifest parsing, and the skip/run decision.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  affectedDirectories,
  changedDirectories,
  changedPaths,
  main,
  owningDirectory,
  readWorkspacePackages,
  runTests,
  spawnVitest,
  WORKSPACE_DEPENDENCY_PREFIX,
  type TestRunner,
} from './verify-changed.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const created: string[] = []

/** Build a throwaway workspace tree and register it for teardown. */
function makeWorkspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-changed-'))
  created.push(root)
  for (const [filePath, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(filePath)), { recursive: true })
    writeFileSync(join(root, filePath), content)
  }
  return root
}

afterEach(() => {
  while (created.length > 0) {
    const root = created.pop()
    /* v8 ignore next -- mkdtempSync always yields a removable directory. */
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

describe('owningDirectory', () => {
  it('reduces a package file to its package directory', () => {
    expect(owningDirectory('packages/api/session-controller/src/commands.ts')).toBe('packages/api/session-controller')
  })

  it('reduces an app file to its app directory', () => {
    expect(owningDirectory('apps/web/src/index.ts')).toBe('apps/web')
  })

  it('accepts a workspace directory given without a child path', () => {
    expect(owningDirectory('packages/api/session-controller')).toBe('packages/api/session-controller')
  })

  it('rejects a path outside both workspace trees', () => {
    expect(owningDirectory('docs/testing.md')).toBeUndefined()
  })

  it('rejects a group path that stops short of a package', () => {
    expect(owningDirectory('packages/api')).toBeUndefined()
  })
})

describe('changedDirectories', () => {
  it('selects only the owners of changed files, without dependents', () => {
    const result = changedDirectories({
      changedFiles: ['packages/tool/session-query/src/index.ts', 'docs/testing.md'],
      packages: [{ name: `${WORKSPACE_DEPENDENCY_PREFIX}session-query`, dir: 'packages/tool/session-query' }],
      dependencies: new Map([['packages/tool/session-query', []]]),
    })
    expect(result).toEqual(['packages/tool/session-query'])
  })
})

describe('affectedDirectories', () => {
  const packages = [
    { name: `${WORKSPACE_DEPENDENCY_PREFIX}session-controller`, dir: 'packages/api/session-controller' },
    { name: `${WORKSPACE_DEPENDENCY_PREFIX}session-query`, dir: 'packages/tool/session-query' },
  ]
  const dependencies = new Map([
    ['packages/api/session-controller', [`${WORKSPACE_DEPENDENCY_PREFIX}session-query`]],
    ['packages/tool/session-query', []],
  ])

  it('selects the directory that owns a changed file', () => {
    const result = affectedDirectories({
      changedFiles: ['packages/api/session-controller/src/commands.ts'],
      packages,
      dependencies,
    })
    expect(result).toEqual(['packages/api/session-controller'])
  })

  it('adds a package that depends on a changed package directly', () => {
    const result = affectedDirectories({
      changedFiles: ['packages/tool/session-query/src/index.ts'],
      packages,
      dependencies,
    })
    expect(result).toEqual(['packages/api/session-controller', 'packages/tool/session-query'])
  })

  it('ignores dependency names that no workspace package publishes', () => {
    const result = affectedDirectories({
      changedFiles: ['packages/tool/session-query/src/index.ts'],
      packages,
      dependencies: new Map([['packages/tool/session-query', ['@deepseek-ai/cordis']]]),
    })
    expect(result).toEqual(['packages/tool/session-query'])
  })

  it('selects nothing when only non-workspace files changed', () => {
    const result = affectedDirectories({ changedFiles: ['docs/testing.md'], packages, dependencies })
    expect(result).toEqual([])
  })

  it('selects nothing when nothing changed', () => {
    expect(affectedDirectories({ changedFiles: [], packages, dependencies })).toEqual([])
  })

  it('expands dependents exactly one level, independent of map order', () => {
    const prefix = WORKSPACE_DEPENDENCY_PREFIX
    const packages = [
      { name: `${prefix}a`, dir: 'packages/x/a' },
      { name: `${prefix}b`, dir: 'packages/x/b' },
      { name: `${prefix}c`, dir: 'packages/x/c' },
    ]
    const base = { changedFiles: ['packages/x/a/src/index.ts'], packages }
    const forward = affectedDirectories({
      ...base,
      dependencies: new Map([['packages/x/b', [`${prefix}a`]], ['packages/x/c', [`${prefix}b`]]]),
    })
    const reverse = affectedDirectories({
      ...base,
      dependencies: new Map([['packages/x/c', [`${prefix}b`]], ['packages/x/b', [`${prefix}a`]]]),
    })
    expect(forward).toEqual(['packages/x/a', 'packages/x/b'])
    expect(reverse).toEqual(['packages/x/a', 'packages/x/b'])
  })
})

describe('readWorkspacePackages', () => {
  it('reads names and direct runtime dependencies, ignoring devDependencies', () => {
    const root = makeWorkspace({
      'packages/api/session-controller/package.json': JSON.stringify({
        name: `${WORKSPACE_DEPENDENCY_PREFIX}session-controller`,
        dependencies: { [`${WORKSPACE_DEPENDENCY_PREFIX}session-query`]: 'workspace:^' },
        devDependencies: { [`${WORKSPACE_DEPENDENCY_PREFIX}util-values`]: 'workspace:^' },
      }),
      'packages/tool/session-query/package.json': JSON.stringify({
        name: `${WORKSPACE_DEPENDENCY_PREFIX}session-query`,
      }),
    })
    const { packages, dependencies } = readWorkspacePackages(root)
    expect(packages).toEqual([
      { name: `${WORKSPACE_DEPENDENCY_PREFIX}session-controller`, dir: 'packages/api/session-controller' },
      { name: `${WORKSPACE_DEPENDENCY_PREFIX}session-query`, dir: 'packages/tool/session-query' },
    ])
    expect(dependencies.get('packages/api/session-controller')).toEqual([
      `${WORKSPACE_DEPENDENCY_PREFIX}session-query`,
    ])
  })

  it('drops dependencies that are not workspace packages', () => {
    const root = makeWorkspace({
      'packages/api/session-controller/package.json': JSON.stringify({
        name: `${WORKSPACE_DEPENDENCY_PREFIX}session-controller`,
        dependencies: { vitest: '^4.1.8', '@deepseek-ai/cordis': 'workspace:^' },
      }),
    })
    const { dependencies } = readWorkspacePackages(root)
    expect(dependencies.get('packages/api/session-controller')).toEqual([])
  })

  it('rejects a manifest that is not JSON', () => {
    const root = makeWorkspace({ 'packages/api/session-controller/package.json': '{ not json' })
    expect(() => readWorkspacePackages(root)).toThrow(/is not valid JSON/)
  })

  it('rejects a manifest without a name', () => {
    const root = makeWorkspace({ 'packages/api/session-controller/package.json': JSON.stringify({ private: true }) })
    expect(() => readWorkspacePackages(root)).toThrow(/has no non-empty "name"/)
  })

  it('rejects a manifest path that cannot be read as a file', () => {
    const root = makeWorkspace({})
    mkdirSync(join(root, 'packages/api/session-controller/package.json'), { recursive: true })
    expect(() => readWorkspacePackages(root)).toThrow(/cannot read/)
  })
})

describe('changedPaths', () => {
  it('reports paths from git inside the repository', () => {
    expect(Array.isArray(changedPaths(repositoryRoot))).toBe(true)
  })

  it('fails when the directory is not a git repository', () => {
    const root = makeWorkspace({})
    expect(() => changedPaths(root)).toThrow(/git diff --name-only HEAD failed/)
  })

  it('fails when git cannot be spawned', () => {
    expect(() => changedPaths(join(tmpdir(), 'verify-changed-absent-git-root'))).toThrow(/cannot run git/)
  })

  it('includes untracked files that git diff omits', () => {
    const probe = join(repositoryRoot, 'scripts', '.verify-changed-untracked-probe.ts')
    writeFileSync(probe, 'export const probe = true\n')
    try {
      expect(changedPaths(repositoryRoot)).toContain('scripts/.verify-changed-untracked-probe.ts')
    } finally {
      rmSync(probe, { force: true })
    }
  })
})

describe('runTests', () => {
  it('skips and succeeds when no package is in scope', () => {
    const run = vi.fn<TestRunner>(() => 0)
    expect(runTests([], repositoryRoot, run)).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })

  it('delegates to the runner when a package is in scope', () => {
    const run = vi.fn<TestRunner>(() => 3)
    expect(runTests(['packages/api/session-controller'], repositoryRoot, run)).toBe(3)
    expect(run).toHaveBeenCalledWith(['packages/api/session-controller'], repositoryRoot)
  })
})

describe('spawnVitest', () => {
  it('returns the child process exit code', () => {
    // `--help` is passed through in place of a directory: vitest prints usage
    // and exits 0 without collecting tests, so this exercises spawn and status
    // propagation at the cost of a process start rather than a suite run.
    expect(spawnVitest(['--help'], repositoryRoot)).toBe(0)
  })

  it('fails when the child cannot be spawned', () => {
    expect(() => spawnVitest(['packages/api/session-controller'], join(tmpdir(), 'verify-changed-absent-root')))
      .toThrow(/cannot run vitest/)
  })
})

describe('main', () => {
  it('lists the affected directories and succeeds', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(main(['--list'], repositoryRoot)).toBe(0)
    } finally {
      log.mockRestore()
    }
  })

  it('runs the affected directories through the injected runner', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = vi.fn<TestRunner>(() => 0)
    try {
      expect(main([], repositoryRoot, run)).toBe(0)
      expect(run).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('narrows the scope to changed packages under --direct-only', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const collected: string[][] = []
    const run: TestRunner = (directories) => {
      collected.push([...directories])
      return 0
    }
    try {
      expect(main([], repositoryRoot, run)).toBe(0)
      expect(main(['--direct-only'], repositoryRoot, run)).toBe(0)
    } finally {
      log.mockRestore()
    }
    const withDependents = collected[0]!
    const directOnly = collected[1]!
    expect(directOnly.every(directory => withDependents.includes(directory))).toBe(true)
    expect(directOnly.length).toBeLessThanOrEqual(withDependents.length)
  })
})
