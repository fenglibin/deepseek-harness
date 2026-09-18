import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { collectWebTestFaceViolations } from './web-test-faces.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const HOST_LANE = 'host-lane.e2e.ts'
const CLIENT_LANE = 'client-lane.e2e.ts'

/** One Host-plane file the Client program must exclude, plus a Client-plane neighbour. */
function workspaceFixture(options: {
  readonly sources: Readonly<Record<string, string>>
  readonly clientExclude: readonly string[]
  readonly hostInclude: readonly string[]
}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-test-faces-'))
  roots.push(root)
  for (const [file, source] of Object.entries(options.sources)) {
    const absolute = join(root, file)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source)
  }
  writeJson(join(root, 'tsconfig.base.json'), {})
  writeJson(join(root, 'apps/web/tsconfig.json'), {
    extends: '../../tsconfig.base.json',
    include: ['tests'],
    exclude: [...options.clientExclude],
  })
  writeJson(join(root, 'tsconfig.host.json'), { include: [...options.hostInclude] })
  return root
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe('web e2e compiler faces', () => {
  it('accepts a Host-plane file the Client program excludes and the Host config includes', () => {
    const root = workspaceFixture({
      sources: {
        [`apps/web/tests/${HOST_LANE}`]: 'export const hostLane = 1\n',
        [`apps/web/tests/${CLIENT_LANE}`]: 'export const clientLane = 1\n',
      },
      clientExclude: [`tests/${HOST_LANE}`],
      hostInclude: [`apps/web/tests/${HOST_LANE}`],
    })

    expect(collectWebTestFaceViolations(root)).toEqual([])
  })

  it('rejects a Client-face file importing the Host web e2e lane', () => {
    const root = workspaceFixture({
      sources: {
        [`apps/web/tests/${HOST_LANE}`]: 'export const hostLane = 1\n',
        [`apps/web/tests/${CLIENT_LANE}`]: `import { hostLane } from './${HOST_LANE}'\n\nexport const clientLane = hostLane\n`,
      },
      clientExclude: [`tests/${HOST_LANE}`],
      hostInclude: [`apps/web/tests/${HOST_LANE}`],
    })

    expect(collectWebTestFaceViolations(root)).toEqual([
      `apps/web/tests/${CLIENT_LANE}: apps/web/tsconfig.json loads this file, but it imports apps/web/tests/${HOST_LANE}, which only the other face loads; register apps/web/tests/${CLIENT_LANE} with the face that owns apps/web/tests/${HOST_LANE}`,
    ])
  })

  it('rejects a Host-face file importing a Client-only source', () => {
    const root = workspaceFixture({
      sources: {
        [`apps/web/tests/${CLIENT_LANE}`]: 'export const clientLane = 1\n',
        [`apps/web/tests/${HOST_LANE}`]: `import { clientLane } from './${CLIENT_LANE}'\n\nexport const hostLane = clientLane\n`,
      },
      clientExclude: [`tests/${HOST_LANE}`],
      hostInclude: [`apps/web/tests/${HOST_LANE}`],
    })

    expect(collectWebTestFaceViolations(root)).toEqual([
      `apps/web/tests/${HOST_LANE}: tsconfig.host.json loads this file, but it imports apps/web/tests/${CLIENT_LANE}, which only the other face loads; register apps/web/tests/${HOST_LANE} with the face that owns apps/web/tests/${CLIENT_LANE}`,
    ])
  })

  it('resolves a specifier that omits the TypeScript extension', () => {
    const root = workspaceFixture({
      sources: {
        [`apps/web/tests/${HOST_LANE}`]: 'export const hostLane = 1\n',
        [`apps/web/tests/${CLIENT_LANE}`]: `import { hostLane } from './${HOST_LANE.replace('.ts', '')}'\n\nexport const clientLane = hostLane\n`,
      },
      clientExclude: [`tests/${HOST_LANE}`],
      hostInclude: [`apps/web/tests/${HOST_LANE}`],
    })

    expect(collectWebTestFaceViolations(root)).toHaveLength(1)
  })

  it('rejects a source no face loads', () => {
    const root = workspaceFixture({
      sources: {
        [`apps/web/tests/${HOST_LANE}`]: 'export const hostLane = 1\n',
        [`apps/web/tests/${CLIENT_LANE}`]: 'export const clientLane = 1\n',
        'apps/web/tests/orphan.e2e.ts': 'export const orphan = 1\n',
      },
      clientExclude: [`tests/${HOST_LANE}`, 'tests/orphan.e2e.ts'],
      hostInclude: [`apps/web/tests/${HOST_LANE}`],
    })

    expect(collectWebTestFaceViolations(root)).toEqual([
      'apps/web/tests/orphan.e2e.ts: no compiler face loads this file; a Host-plane file needs both an apps/web/tsconfig.json "exclude" entry and a tsconfig.host.json "include" entry',
    ])
  })

  it('rejects registration entries that name no file', () => {
    const root = workspaceFixture({
      sources: {
        [`apps/web/tests/${HOST_LANE}`]: 'export const hostLane = 1\n',
        [`apps/web/tests/${CLIENT_LANE}`]: 'export const clientLane = 1\n',
      },
      clientExclude: [`tests/${HOST_LANE}`, 'tests/gone.e2e.ts'],
      hostInclude: [`apps/web/tests/${HOST_LANE}`, 'apps/web/tests/also-gone.e2e.ts'],
    })

    expect(collectWebTestFaceViolations(root)).toEqual([
      'apps/web/tsconfig.json: exclude entry "tests/gone.e2e.ts" names no file',
      'tsconfig.host.json: include entry "apps/web/tests/also-gone.e2e.ts" names no file',
    ])
  })
})

describe('repository web e2e registration', () => {
  it('registers every repository source with exactly one face', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))

    expect(collectWebTestFaceViolations(root)).toEqual([])
  })
})
