/**
 * The controller layer: workspace resolution, translation of every structured
 * refusal onto its wire code, and the image bytes route. The storage contract
 * itself is covered by the workspace-io suite; what is asserted here is the
 * mapping a browser actually branches on.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import FileBrowserController, { FILE_BROWSER_ASSET_PATH } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** One temporary workspace directory on the real filesystem. */
function workspaceDirectory(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-file-browser-controller-')))
}

interface RegisteredRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

interface Harness {
  readonly ctx: Context
  readonly controller: FileBrowserController
  readonly root: string
  readonly workspaceId: WorkspaceId
  readonly routes: RegisteredRoute[]
}

/**
 * Build the controller over a real workspace root, with the typert binding and
 * the connection route registry stubbed: neither is what this suite asserts.
 */
async function harness(overrides: Partial<{ registered: boolean; config: Config }> = {}): Promise<Harness> {
  const root = workspaceDirectory()
  const ctx = new Context()
  contexts.push(ctx)
  const workspaceId = 'ws-1' as WorkspaceId
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
  } as never)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => (id === workspaceId ? { id: workspaceId, path: root } : undefined),
  } as never)
  const routes: RegisteredRoute[] = []
  if (overrides.registered !== false) {
    ctx.provide('connection', {
      fetch: {
        register: (route: RegisteredRoute) => {
          routes.push(route)
          return () => Promise.resolve()
        },
      },
    } as never)
  }
  const controller = new FileBrowserController(ctx, overrides.config ?? {})
  return { ctx, controller, root, workspaceId, routes }
}

/** The wire code of a refused call, or undefined when it resolved. */
async function refusalCode(operation: Promise<unknown>): Promise<string | undefined> {
  return operation.then(() => undefined, (error: unknown) => remoteErrorOf(error)?.code)
}

describe('workspace resolution', () => {
  it('refuses an unknown workspace id', async () => {
    const { controller, root } = await harness()
    writeFileSync(join(root, 'a.txt'), 'a')
    expect(await refusalCode(controller.list({ workspaceId: 'nope' as WorkspaceId }))).toBe('file-browser/not-found')
  })
})

describe('wire failure translation', () => {
  it('maps a containment refusal to outside-workspace', async () => {
    const { controller, workspaceId } = await harness()
    expect(await refusalCode(controller.read({ workspaceId, path: '../secret.txt' }))).toBe('file-browser/outside-workspace')
  })

  it('maps a missing file to not-found', async () => {
    const { controller, workspaceId } = await harness()
    expect(await refusalCode(controller.read({ workspaceId, path: 'gone.txt' }))).toBe('file-browser/not-found')
  })

  it('maps a stale guarded write to stale', async () => {
    const { controller, workspaceId, root } = await harness()
    writeFileSync(join(root, 'a.txt'), 'first')
    const read = await controller.read({ workspaceId, path: 'a.txt' })
    if (read.kind !== 'text') throw new Error('expected text')
    writeFileSync(join(root, 'a.txt'), 'changed')
    expect(await refusalCode(controller.write({ workspaceId, path: 'a.txt', content: 'mine', version: read.version })))
      .toBe('file-browser/stale')
  })

  it('maps an occupied name to exists', async () => {
    const { controller, workspaceId, root } = await harness()
    writeFileSync(join(root, 'a.txt'), 'a')
    expect(await refusalCode(controller.create({ workspaceId, name: 'a.txt', kind: 'file' })))
      .toBe('file-browser/exists')
  })

  it('maps a non-segment name to invalid-name', async () => {
    const { controller, workspaceId } = await harness()
    expect(await refusalCode(controller.create({ workspaceId, name: 'a/b', kind: 'file' })))
      .toBe('file-browser/invalid-name')
  })

  it('maps a directory listed as a file to unsupported', async () => {
    const { controller, workspaceId, root } = await harness()
    mkdirSync(join(root, 'adir'))
    expect(await refusalCode(controller.read({ workspaceId, path: 'adir' }))).toBe('file-browser/unsupported')
  })
})

describe('remote operations', () => {
  it('lists, reads, writes, creates, renames, searches, and deletes through the controller', async () => {
    const { controller, workspaceId, root } = await harness()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'main.ts'), 'export {}\n')

    const listing = await controller.list({ workspaceId, path: 'src' })
    expect(listing.entries.map(entry => entry.path)).toEqual(['src/main.ts'])

    const read = await controller.read({ workspaceId, path: 'src/main.ts' })
    expect(read.kind).toBe('text')

    const written = await controller.write({ workspaceId, path: 'src/main.ts', content: 'export const x = 1\n' })
    expect(written.version).toMatch(/:/)

    const created = await controller.create({ workspaceId, directory: 'src', name: 'extra.ts', kind: 'file' })
    expect(created.path).toBe('src/extra.ts')

    const renamed = await controller.rename({ workspaceId, path: 'src/extra.ts', name: 'renamed.ts' })
    expect(renamed.path).toBe('src/renamed.ts')

    const found = await controller.search({ workspaceId, query: 'renamed' })
    expect(found.matches.map(match => match.path)).toEqual(['src/renamed.ts'])

    await controller.delete({ workspaceId, path: 'src/renamed.ts' })
    const after = await controller.list({ workspaceId, path: 'src' })
    expect(after.entries.map(entry => entry.path)).toEqual(['src/main.ts'])
  })

  it('honors a configured file-size bound', async () => {
    const { controller, workspaceId, root } = await harness({ config: { maxFileBytes: 4 } })
    writeFileSync(join(root, 'big.txt'), 'way too long')
    expect(await controller.read({ workspaceId, path: 'big.txt' }))
      .toEqual({ kind: 'too-large', size: 12, limit: 4 })
  })
})

describe('image bytes route', () => {
  it('registers the route at the documented path for GET and HEAD', async () => {
    const { routes } = await harness()
    expect(routes).toHaveLength(1)
    expect(routes[0]?.path).toBe(FILE_BROWSER_ASSET_PATH)
    expect([...(routes[0]?.methods ?? [])]).toEqual(['GET', 'HEAD'])
  })

  it('serves image bytes with the media type and length', async () => {
    const { controller, workspaceId, root, routes } = await harness()
    void controller
    writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const request = new Request(`http://localhost${FILE_BROWSER_ASSET_PATH}?workspaceId=${workspaceId}&path=pic.png`)
    const response = await (routes[0]?.fetch(request) as Promise<Response>)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe('4')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  it('refuses a missing query parameter', async () => {
    const { routes } = await harness()
    const response = await (routes[0]?.fetch(new Request(`http://localhost${FILE_BROWSER_ASSET_PATH}`)) as Promise<Response>)
    expect(response.status).toBe(400)
  })

  it('refuses an unknown workspace', async () => {
    const { routes } = await harness()
    const request = new Request(`http://localhost${FILE_BROWSER_ASSET_PATH}?workspaceId=nope&path=a.png`)
    expect((await (routes[0]?.fetch(request) as Promise<Response>)).status).toBe(404)
  })

  it('refuses a path outside the workspace even through a symlink', async () => {
    const { routes, root } = await harness()
    const outside = workspaceDirectory()
    writeFileSync(join(outside, 'secret.png'), 'bytes')
    symlinkSync(join(outside, 'secret.png'), join(root, 'link.png'))
    const request = new Request(`http://localhost${FILE_BROWSER_ASSET_PATH}?workspaceId=ws-1&path=link.png`)
    expect((await (routes[0]?.fetch(request) as Promise<Response>)).status).toBe(403)
  })

  it('refuses a name that is not an image kind', async () => {
    const { routes, root } = await harness()
    writeFileSync(join(root, 'a.txt'), 'x')
    const request = new Request(`http://localhost${FILE_BROWSER_ASSET_PATH}?workspaceId=ws-1&path=a.txt`)
    expect((await (routes[0]?.fetch(request) as Promise<Response>)).status).toBe(403)
  })

  it('fails loudly when the connection carrier is absent', async () => {
    // The carrier is a declared injection, so composing this plugin without one
    // is a wiring fault. Silently skipping the route would leave every image
    // 404 while the Remote verbs kept answering.
    await expect(harness({ registered: false })).rejects.toThrow()
  })
})
