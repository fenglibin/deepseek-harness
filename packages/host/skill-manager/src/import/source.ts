/**
 * Import sources reduced to one validated file list.
 *
 * Two source shapes are accepted: a GitHub repository location, read through
 * the contents API so a skill living in a subdirectory works the same as one
 * at the repository root, and a direct archive URL, downloaded and unpacked.
 * Both end at the same validated member list, so the preview a reader approves
 * describes exactly what will be written.
 *
 * The transport is a parameter rather than a global so a test can drive every
 * branch without reaching the network.
 * @module @deepseek-ai/dsh-host-skill-manager/import/source
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { detectFormat, safeEntryPath, stripWrapperDirectory, unpack, type UnpackLimits, type UnpackedEntry } from './archive.ts'

/** Headers and body surface the importer needs from a transport. */
export interface ImportResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get: (name: string) => string | null }
  arrayBuffer: () => Promise<ArrayBuffer>
}

/** Transport the importer reads through. */
export type ImportFetch = (url: string, init?: { readonly headers?: Record<string, string> }) => Promise<ImportResponse>

/** One import to resolve. */
export interface ImportRequest {
  /** GitHub location (`owner/repo[/path][@ref]`, or a `github.com` URL) or a direct archive URL. */
  readonly source: string
}

/** The files one import resolves to, before anything is written. */
export interface ImportPlan {
  /** Files to write, relative to the skill directory. */
  readonly files: readonly UnpackedEntry[]
  /** Human-readable origin the preview shows. */
  readonly origin: string
}

/** Deepest directory nesting a GitHub import follows. */
const MAX_GITHUB_DEPTH = 4

/** User agent the GitHub API requires. */
const USER_AGENT = 'deepseek-harness-skill-manager'

/** One GitHub contents-API row. */
interface ContentsRow {
  readonly type?: unknown
  readonly name?: unknown
  readonly path?: unknown
  readonly size?: unknown
  readonly download_url?: unknown
}

/**
 * Resolve one import source into the files it would write.
 * @param request - the source to resolve.
 * @param fetchImpl - transport to read through.
 * @param limits - counts and sizes the resolved file list must stay within.
 * @returns the validated file list and the origin a preview reports.
 * @throws {RemoteError} `skill-admin/import-unreachable` when a request fails,
 * `skill-admin/import-unreadable` when the payload cannot be unpacked, or
 * `skill-admin/import-no-skill` when no usable entry point is found.
 */
export async function planImport(
  request: ImportRequest,
  fetchImpl: ImportFetch,
  limits: UnpackLimits,
): Promise<ImportPlan> {
  const github = parseGitHubSource(request.source)
  if (github !== undefined) return await planGitHub(github, fetchImpl, limits)
  return await planArchive(request.source, fetchImpl, limits)
}

/** A GitHub location split into repository, optional subdirectory, and optional ref. */
interface GitHubSource {
  readonly owner: string
  readonly repo: string
  readonly path: string
  readonly ref?: string
}

/**
 * Read a capture group the pattern requires.
 * @param match - a match whose required groups all participate.
 * @param index - index of a group the pattern cannot leave unmatched.
 * @returns the captured text.
 */
function requiredGroup(match: RegExpExecArray, index: number): string {
  /* v8 ignore next -- every caller names a group its pattern requires, so the fallback only satisfies the index signature. */
  return match[index] ?? ''
}

/**
 * Split a GitHub location, or report that this source is not one.
 * @param source - the raw source a user typed.
 * @returns the parsed location, or undefined when the source is not a GitHub one.
 */
export function parseGitHubSource(source: string): GitHubSource | undefined {
  const trimmed = source.trim()
  const fromUrl = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/([^/\s]+)((?:\/[^\s#?]*)?))?/i.exec(trimmed)
  if (fromUrl !== null) {
    const ref = fromUrl[3]
    const rest = fromUrl[4]
    return {
      owner: requiredGroup(fromUrl, 1),
      repo: requiredGroup(fromUrl, 2).replace(/\.git$/u, ''),
      path: (rest ?? '').replace(/^\/+|\/+$/gu, ''),
      ...ref === undefined ? {} : { ref },
    }
  }
  const shorthand = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)((?:\/[^\s@]*)?)(?:@([^\s]+))?$/u.exec(trimmed)
  if (shorthand === null) return undefined
  const rest = shorthand[3]
  const ref = shorthand[4]
  return {
    owner: requiredGroup(shorthand, 1),
    repo: requiredGroup(shorthand, 2),
    /* v8 ignore next -- the capture group always participates, so it yields an
     * empty string rather than undefined for a source without a subpath; the
     * fallback exists only because the indexed element is typed optional. */
    path: (rest ?? '').replace(/^\/+|\/+$/gu, ''),
    ...ref === undefined ? {} : { ref },
  }
}

/** Read one GitHub directory tree through the contents API. */
async function planGitHub(source: GitHubSource, fetchImpl: ImportFetch, limits: UnpackLimits): Promise<ImportPlan> {
  const files: UnpackedEntry[] = []
  /** Bytes actually retained; the bound is enforced against this. */
  let total = 0
  /** Bytes the listing claims; a pre-flight gate that saves a download. */
  let declaredTotal = 0
  const queue: Array<{ path: string; depth: number }> = [{ path: source.path, depth: 0 }]
  while (queue.length > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    const next = queue.shift()!
    const api = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${next.path}`
      + (source.ref === undefined ? '' : `?ref=${encodeURIComponent(source.ref)}`)
    const rows = await readJson(api, fetchImpl)
    if (!Array.isArray(rows)) {
      throw new RemoteError('skill-admin/import-unreadable', `GitHub returned no directory listing for ${JSON.stringify(next.path)}`, {
        reason: 'the contents API did not answer with a directory',
      })
    }
    for (const raw of rows as ContentsRow[]) {
      const rowPath = typeof raw.path === 'string' ? raw.path : undefined
      if (rowPath === undefined) continue
      if (raw.type === 'dir') {
        if (next.depth + 1 > MAX_GITHUB_DEPTH) {
          throw new RemoteError('skill-admin/import-unreadable', 'the GitHub tree nests deeper than the importer follows', {
            reason: `deeper than ${MAX_GITHUB_DEPTH} directories`,
          })
        }
        queue.push({ path: rowPath, depth: next.depth + 1 })
        continue
      }
      if (raw.type !== 'file') continue
      const size = typeof raw.size === 'number' ? raw.size : 0
      if (size > limits.maxFileBytes) {
        throw new RemoteError('skill-admin/import-unreadable', `repository file ${JSON.stringify(rowPath)} is too large`, {
          reason: `${size} bytes exceeds the ${limits.maxFileBytes}-byte per-file limit`,
        })
      }
      // The declared sizes are summed separately from the bytes actually
      // retained: counting both into one running total would charge every file
      // twice and reject imports that are within the bound.
      declaredTotal += size
      if (declaredTotal > limits.maxTotalBytes) {
        throw new RemoteError('skill-admin/import-unreadable', 'the import exceeds the total size limit', {
          reason: `${declaredTotal} bytes exceeds the ${limits.maxTotalBytes}-byte total limit`,
        })
      }
      if (files.length >= limits.maxEntries) {
        throw new RemoteError('skill-admin/import-unreadable', 'the import holds too many files', {
          reason: `more than ${limits.maxEntries} files`,
        })
      }
      // The path is validated before the request: a row that does not belong
      // to the requested subdirectory is refused without a wasted download.
      const relative = safeEntryPath(relativeTo(rowPath, source.path))
      const url = typeof raw.download_url === 'string'
        ? raw.download_url
        : `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref ?? 'HEAD'}/${rowPath}`
      // The declared size bounds the *request*; the bytes actually returned
      // are what gets written, so they are the ones the bound is checked
      // against. An API listing is not a trusted statement about a download.
      const bytes = await readBytes(url, fetchImpl)
      if (bytes.byteLength > limits.maxFileBytes) {
        throw new RemoteError('skill-admin/import-unreadable', `repository file ${JSON.stringify(rowPath)} is too large`, {
          reason: `${bytes.byteLength} bytes exceeds the ${limits.maxFileBytes}-byte per-file limit`,
        })
      }
      total += bytes.byteLength
      if (total > limits.maxTotalBytes) {
        throw new RemoteError('skill-admin/import-unreadable', 'the import exceeds the total size limit', {
          reason: `${total} bytes exceeds the ${limits.maxTotalBytes}-byte total limit`,
        })
      }
      files.push({ path: relative, bytes })
    }
  }
  return finish(files, `github:${source.owner}/${source.repo}${source.path === '' ? '' : `/${source.path}`}`)
}

/** Download one archive URL and unpack it. */
async function planArchive(source: string, fetchImpl: ImportFetch, limits: UnpackLimits): Promise<ImportPlan> {
  if (!/^https?:\/\//iu.test(source.trim())) {
    throw new RemoteError('skill-admin/import-unreadable', `import source ${JSON.stringify(source)} is not a URL or a GitHub location`, {
      reason: 'expected an https URL or owner/repo',
    })
  }
  const body = await readBytes(source.trim(), fetchImpl, true)
  return planArchiveBytes(body, body.contentType ?? source, limits, source.trim())
}

/**
 * Unpack archive bytes the caller already holds.
 *
 * A browser upload arrives decoded rather than downloaded, and it must reach
 * the same entry list a URL import reaches: the file list a reader approves is
 * only honest while both sources pass through one unpacking step and one set of
 * integrity checks.
 * @param bytes - the complete archive.
 * @param hint - container hint (upload filename or content type), used only when the magic bytes are inconclusive.
 * @param limits - counts and sizes the resolved file list must stay within.
 * @param origin - human-readable origin the preview reports.
 * @returns the validated file list and the origin a preview reports.
 * @throws {RemoteError} `skill-admin/import-unreadable` when the payload cannot
 * be unpacked, or `skill-admin/import-no-skill` when no usable entry point is found.
 */
export function planArchiveBytes(
  bytes: Uint8Array,
  hint: string,
  limits: UnpackLimits,
  origin: string,
): ImportPlan {
  const format = detectFormat(bytes, hint)
  return finish(stripWrapperDirectory(unpack(bytes, format, limits)), origin)
}

/** Require a usable entry point and hand back the plan. */
function finish(files: readonly UnpackedEntry[], origin: string): ImportPlan {
  if (!files.some(file => file.path === 'SKILL.md')) {
    throw new RemoteError('skill-admin/import-no-skill', 'the import carries no SKILL.md at its root', {
      reason: 'a skill is a directory holding SKILL.md',
    })
  }
  return { files, origin }
}

/** Address one member relative to the imported subdirectory. */
function relativeTo(path: string, prefix: string): string {
  if (prefix === '') return path
  if (!path.startsWith(`${prefix}/`)) {
    throw new RemoteError('skill-admin/import-unreadable', `GitHub returned ${JSON.stringify(path)} outside ${JSON.stringify(prefix)}`, {
      reason: 'the listing left the requested subdirectory',
    })
  }
  return path.slice(prefix.length + 1)
}

/** Read one URL as JSON, translating transport and status failures. */
async function readJson(url: string, fetchImpl: ImportFetch): Promise<unknown> {
  const response = await call(url, fetchImpl)
  if (!response.ok) {
    throw new RemoteError('skill-admin/import-unreachable', `GitHub answered ${response.status} for ${url}`, {
      reason: `HTTP ${response.status}`,
    })
  }
  return JSON.parse(Buffer.from(await response.arrayBuffer()).toString('utf8')) as unknown
}

/** Read one URL as bytes, translating transport failures. */
async function readBytes(
  url: string,
  fetchImpl: ImportFetch,
  withType = false,
): Promise<Uint8Array & { contentType?: string }> {
  const response = await call(url, fetchImpl)
  if (!response.ok) {
    throw new RemoteError('skill-admin/import-unreachable', `the download answered ${response.status} for ${url}`, {
      reason: `HTTP ${response.status}`,
    })
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!withType) return bytes
  const contentType = response.headers.get('content-type')
  return contentType === null ? bytes : Object.assign(bytes, { contentType })
}

/** Perform one request, translating a transport-level failure. */
async function call(url: string, fetchImpl: ImportFetch): Promise<ImportResponse> {
  try {
    return await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json, */*' } })
  } catch (error: unknown) {
    throw new RemoteError('skill-admin/import-unreachable', `could not reach ${url}`, { reason: String(error) })
  }
}
