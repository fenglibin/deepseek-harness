/**
 * Host owner of the `fileBrowser` Remote namespace and the `/api/file.asset`
 * bytes route: both resolve a workspace, contain the target, and delegate to
 * {@link ./workspace-io.ts}.
 *
 * The route and the Remote share one containment implementation on purpose —
 * the image path is the same trust question as the text path, and a second
 * copy would be a second place for it to drift.
 * @module @deepseek-ai/dsh-api-file-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: resolves the `workspaceRegistry` Context augmentation this controller reads.
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SEARCH_LIMIT,
  WorkspaceIoError,
  createEntry,
  deleteEntry,
  listDirectory,
  readFileContent,
  readImageBytes,
  renameEntry,
  searchNames,
  writeFileContent,
  type WorkspaceIoLimits,
} from './workspace-io.ts'
import type {
  FileBrowserContent,
  FileBrowserCreateRequest,
  FileBrowserCreateValue,
  FileBrowserDeleteRequest,
  FileBrowserListing,
  FileBrowserListRequest,
  FileBrowserReadRequest,
  FileBrowserRenameRequest,
  FileBrowserRenameValue,
  FileBrowserSearchRequest,
  FileBrowserSearchResult,
  FileBrowserWriteRequest,
  FileBrowserWriteValue,
} from './types.ts'

export type * from './types.ts'
export {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SEARCH_LIMIT,
  WorkspaceIoError,
} from './workspace-io.ts'

/** Path the browser fetches image bytes from. */
export const FILE_BROWSER_ASSET_PATH = '/api/file.asset'

/** Inclusive byte ceiling for one image served over the bytes route. */
export const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** File-browser policy: what the browser will open and how much it will report. */
export interface Config {
  /** Inclusive byte ceiling of a file the editor opens. @default 2097152 */
  readonly maxFileBytes?: number
  /** Inclusive byte ceiling of an image served over the bytes route. @default 33554432 */
  readonly maxImageBytes?: number
  /** Direct children reported for one directory level. @default 2000 */
  readonly listLimit?: number
  /** Name-search hits reported before the result is cut. @default 500 */
  readonly searchLimit?: number
}

/** Validate file-browser policy. */
const configSchema: Schema<Config> = Schema.object({
  maxFileBytes: Schema.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
  maxImageBytes: Schema.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
  listLimit: Schema.number().step(1).min(1).default(DEFAULT_LIST_LIMIT),
  searchLimit: Schema.number().step(1).min(1).default(DEFAULT_SEARCH_LIMIT),
})

/**
 * The connection service subset this plugin registers its bytes route through.
 * Declared structurally rather than by importing the connection package: that
 * package's Context merge would pull its whole compilation graph into this
 * project, and the route registry is the only surface reachable here.
 */
interface FileBrowserConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD')[]
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host file-browser business API and Remote namespace owner. */
    fileBrowserController: FileBrowserController
  }
}

/** Host service backing the generated `ctx.remote.fileBrowser` namespace. */
export class FileBrowserController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'connection']

  /** Validated plugin configuration; the Loader resolves it before construction. */
  static Config = configSchema

  private readonly limits: WorkspaceIoLimits
  private readonly maxImageBytes: number

  /**
   * @param ctx - Host context carrying the Workspace registry.
   * @param config - resolved byte and result bounds.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'fileBrowserController', { namespace: 'fileBrowser' })
    this.limits = {
      maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      listLimit: config.listLimit ?? DEFAULT_LIST_LIMIT,
      searchLimit: config.searchLimit ?? DEFAULT_SEARCH_LIMIT,
    }
    this.maxImageBytes = config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
    this.registerAssetRoute()
  }

  /**
   * List one directory level of a workspace.
   * @param request - workspace, directory, and hidden-files choice.
   * @returns the level's direct children.
   */
  @Remote('list')
  list(request: FileBrowserListRequest): Promise<FileBrowserListing> {
    return this.guard(() => listDirectory(
      this.rootOf(request.workspaceId), request.path, request.showHidden === true, this.limits))
  }

  /**
   * Read one file as content the browser can present.
   * @param request - workspace and workspace-relative file path.
   * @returns the arm describing this file (text, image, binary, or over the bound).
   */
  @Remote('read')
  read(request: FileBrowserReadRequest): Promise<FileBrowserContent> {
    return this.guard(() => readFileContent(
      this.rootOf(request.workspaceId),
      request.path,
      this.limits,
      relativePath => assetUrlOf(request.workspaceId, relativePath),
    ))
  }

  /**
   * Write one file, atomically and optionally guarded by the version read.
   * @param request - workspace, path, content, and the version the caller read.
   * @returns the version the write produced.
   */
  @Remote('write')
  write(request: FileBrowserWriteRequest): Promise<FileBrowserWriteValue> {
    return this.guard(async () => ({
      version: await writeFileContent(
        this.rootOf(request.workspaceId), request.path, request.content, request.version, this.limits),
    }))
  }

  /**
   * Create one file or directory inside a workspace directory.
   * @param request - workspace, parent directory, name, and entry kind.
   * @returns the created entry's workspace-relative path.
   */
  @Remote('create')
  create(request: FileBrowserCreateRequest): Promise<FileBrowserCreateValue> {
    return this.guard(async () => ({
      path: await createEntry(
        this.rootOf(request.workspaceId), request.directory, request.name, request.kind),
    }))
  }

  /**
   * Rename one entry within its own directory.
   * @param request - workspace, current path, and the replacement base name.
   * @returns the entry's path after the move.
   */
  @Remote('rename')
  rename(request: FileBrowserRenameRequest): Promise<FileBrowserRenameValue> {
    return this.guard(async () => ({
      path: await renameEntry(this.rootOf(request.workspaceId), request.path, request.name),
    }))
  }

  /**
   * Delete one file or directory.
   * @param request - workspace and workspace-relative entry path.
   * @returns nothing on success; a refusal rejects.
   */
  @Remote('delete')
  delete(request: FileBrowserDeleteRequest): Promise<void> {
    return this.guard(() => deleteEntry(this.rootOf(request.workspaceId), request.path))
  }

  /**
   * Search entry names under a workspace root.
   * @param request - workspace and case-insensitive name fragment.
   * @returns the matches with a truncation flag.
   */
  @Remote('search')
  search(request: FileBrowserSearchRequest): Promise<FileBrowserSearchResult> {
    return this.guard(() => searchNames(this.rootOf(request.workspaceId), request.query, this.limits, { showHidden: false }))
  }

  /**
   * Resolve one workspace id to its canonical root directory.
   * @param workspaceId - Workspace identity from the request.
   * @returns the workspace's canonical absolute path.
   * @throws {RemoteError} `file-browser/not-found` when the id names no Workspace.
   */
  private rootOf(workspaceId: WorkspaceId): string {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      throw new RemoteError('file-browser/not-found', `no such workspace: ${String(workspaceId)}`, { path: String(workspaceId) })
    }
    return workspace.path
  }

  /**
   * Run one workspace operation, translating its structured refusal onto the
   * wire. Every failure this layer can name carries a code the browser branches
   * on, so nothing is flattened into a generic transport error.
   */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      if (error instanceof WorkspaceIoError) throw toRemoteError(error)
      throw error
    }
  }

  /**
   * Register the bytes route images are fetched from. `connection` is a declared
   * injection, so the carrier is up before this runs — a route registered
   * against a missing registry would silently leave every image 404 while the
   * Remote verbs kept working. The route repeats the Remote's own workspace
   * resolution and containment, so a caller cannot reach a file through
   * `<img src>` that a `read` would refuse.
   */
  private registerAssetRoute(): void {
    const connection = Reflect.get(this.ctx, 'connection') as FileBrowserConnection
    connection.fetch.register({
      path: FILE_BROWSER_ASSET_PATH,
      methods: ['GET', 'HEAD'],
      fetch: async (request) => {
        const response = await this.assetResponse(request)
        if (request.method === 'GET') return response
        await response.body?.cancel()
        return new Response(null, { status: response.status, headers: response.headers })
      },
    })
  }

  /** Build the bytes response for one asset request, answering every refusal by status. */
  private async assetResponse(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get('workspaceId')
    const path = url.searchParams.get('path')
    if (workspaceId === null || workspaceId === '' || path === null || path === '') {
      return new Response('missing workspaceId or path query parameter', { status: 400 })
    }
    const workspace = this.ctx.workspaceRegistry.get(workspaceId as WorkspaceId)
    if (workspace === undefined) return new Response('no such workspace', { status: 404 })
    try {
      const asset = await readImageBytes(workspace.path, path, this.maxImageBytes)
      return new Response(new Uint8Array(asset.bytes), {
        headers: {
          'content-type': asset.mediaType,
          'content-length': String(asset.bytes.byteLength),
          'cache-control': 'no-store',
        },
      })
    } catch (error: unknown) {
      if (error instanceof WorkspaceIoError) {
        return new Response(error.message, { status: error.code === 'not-found' ? 404 : 403 })
      }
      return new Response('image could not be read', { status: 500 })
    }
  }
}

/**
 * Compose the bytes-route URL for one workspace-relative image path. Relative,
 * so the browser resolves it against the page it is already talking to — the
 * same shape the Session-log download uses for its own route.
 * @param workspaceId - Workspace the image belongs to.
 * @param relativePath - workspace-relative image path.
 * @returns the URL the browser loads the image from.
 */
function assetUrlOf(workspaceId: WorkspaceId, relativePath: string): string {
  const query = new URLSearchParams({ workspaceId: String(workspaceId), path: relativePath })
  return `${FILE_BROWSER_ASSET_PATH}?${query.toString()}`
}

/**
 * Map one structured workspace refusal onto the wire failure the browser reads.
 * @param error - the refusal raised by the workspace layer.
 * @returns the Remote error carrying the matching stable code.
 */
function toRemoteError(error: WorkspaceIoError): RemoteError {
  switch (error.code) {
    case 'outside-workspace':
      return new RemoteError('file-browser/outside-workspace', error.message, { path: error.path })
    case 'not-found':
      return new RemoteError('file-browser/not-found', error.message, { path: error.path })
    case 'stale':
      return new RemoteError('file-browser/stale', error.message, { path: error.path })
    case 'exists':
      return new RemoteError('file-browser/exists', error.message, { path: error.path })
    case 'invalid-name':
      return new RemoteError('file-browser/invalid-name', error.message, { name: error.path })
    case 'unreadable':
      return new RemoteError('file-browser/unreadable', error.message, { path: error.path })
    case 'unsupported':
      return new RemoteError('file-browser/unsupported', error.message, { path: error.path, reason: error.message })
    /* v8 ignore next 2 -- closed union backstop; the union above covers every code. */
    default:
      return new RemoteError('file-browser/unsupported', error.message, { path: error.path, reason: error.message })
  }
}

export default FileBrowserController
