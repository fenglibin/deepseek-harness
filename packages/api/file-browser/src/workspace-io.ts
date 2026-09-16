/**
 * The workspace-scoped filesystem operations behind the `fileBrowser` Remote:
 * listing, text reads and guarded writes, create/rename/delete, and name
 * search.
 *
 * Every entry point takes the workspace root and a workspace-relative path, and
 * every one of them contains the resolved target before touching the disk.
 * Writes publish atomically through a same-directory temporary file plus
 * `rename`, and carry an `mtimeMs:size` token so a caller can refuse to
 * overwrite a file someone else changed.
 *
 * Nothing here consults the calling session's sandbox mode: editing a file
 * through the browser is the operator's own explicit action on their own
 * workspace, not a model mutation, so the workspace root is the whole fence.
 * @module @deepseek-ai/dsh-api-file-browser/workspace-io
 */

import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { containPath, EscapeError, joinWorkspacePath, LexicalEscapeError } from './containment.ts'
import type {
  FileBrowserContent,
  FileBrowserEntry,
  FileBrowserImageMediaType,
  FileBrowserListing,
  FileBrowserSearchMatch,
  FileBrowserSearchResult,
} from './types.ts'

/** Direct children reported for one level before the listing is cut. */
export const DEFAULT_LIST_LIMIT = 2000

/** Name-search hits reported before the result is cut. */
export const DEFAULT_SEARCH_LIMIT = 500

/** Inclusive byte ceiling of a file the editor will open. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Bytes sampled to decide whether a file is text. Published because the sample
 * size is what decides the classification's boundary behavior: a caller that
 * cares where a file stops being readable text needs the same number the
 * classifier uses, not a copy of it.
 */
export const SNIFF_BYTES = 8192

/**
 * Directory names hidden unless the operator asks for them. These are the
 * trees that dominate a workspace listing while nobody browses them by hand,
 * so hiding them by default is what keeps the tree usable.
 */
const HEAVY_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.venv', '__pycache__',
  '.next', '.cache', 'coverage', '.turbo',
])

/** Extension-to-media-type map for the images this browser renders. */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, FileBrowserImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** One workspace operation refused by this layer, already carrying its wire code. */
export class WorkspaceIoError extends Error {
  override readonly name = 'WorkspaceIoError'

  /**
   * @param code - stable `file-browser/*` failure code.
   * @param message - human diagnostic.
   * @param path - workspace-relative or offending path the failure is about.
   */
  constructor(
    readonly code: 'outside-workspace' | 'not-found' | 'stale' | 'exists' | 'invalid-name' | 'unreadable' | 'unsupported',
    message: string,
    readonly path: string,
  ) {
    super(message)
  }
}

/** Inclusive byte limit applied to one file read. */
export interface WorkspaceIoLimits {
  readonly maxFileBytes: number
  readonly listLimit: number
  readonly searchLimit: number
}

/**
 * Resolve a workspace-relative path to a contained absolute one, mapping every
 * containment refusal onto the same wire failure.
 * @param root - absolute workspace root.
 * @param relativePath - workspace-relative path; empty means the root.
 * @returns the canonical absolute path.
 * @throws {WorkspaceIoError} `outside-workspace`.
 */
async function contained(root: string, relativePath: string | undefined): Promise<string> {
  try {
    return await containPath(root, joinWorkspacePath(root, relativePath))
  } catch (error: unknown) {
    if (error instanceof LexicalEscapeError || error instanceof EscapeError) {
      throw new WorkspaceIoError('outside-workspace', error.message, relativePath ?? '')
    }
    throw error
  }
}

/**
 * Resolve an already-absolute path through the same containment rule, for the
 * callers that build a target from a resolved parent rather than from a caller
 * string.
 * @param root - absolute workspace root.
 * @param absolute - the absolute target to contain.
 * @param displayPath - path to name in the refusal.
 * @returns the canonical absolute path.
 * @throws {WorkspaceIoError} `outside-workspace`.
 */
async function containedAbsolute(root: string, absolute: string, displayPath: string): Promise<string> {
  try {
    return await containPath(root, absolute)
  } catch (error: unknown) {
    if (error instanceof EscapeError) {
      throw new WorkspaceIoError('outside-workspace', error.message, displayPath)
    }
    throw error
  }
}

/** The workspace-relative form of an absolute contained path. */
function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).replaceAll('\\', '/')
}

/** Whether a listing row is hidden by default. */
function isHidden(name: string): boolean {
  return name.startsWith('.') || HEAVY_DIRECTORIES.has(name)
}

/**
 * List one directory level.
 * @param root - absolute workspace root.
 * @param relativePath - workspace-relative directory; empty means the root.
 * @param showHidden - include dot-prefixed entries and heavy build directories.
 * @param limits - listing bound.
 * @returns the level's children with a truncation flag.
 * @throws {WorkspaceIoError} `not-found` when the target is absent, `unreadable` when it is not a listable directory.
 */
export async function listDirectory(
  root: string,
  relativePath: string | undefined,
  showHidden: boolean,
  limits: WorkspaceIoLimits,
): Promise<FileBrowserListing> {
  const absolute = await contained(root, relativePath)
  const info = await statOrUndefined(absolute)
  if (info === undefined) {
    throw new WorkspaceIoError('not-found', `no such directory: ${JSON.stringify(relativePath ?? '')}`, relativePath ?? '')
  }
  if (!info.isDirectory()) {
    throw new WorkspaceIoError('unreadable', `not a directory: ${JSON.stringify(relativePath ?? '')}`, relativePath ?? '')
  }
  let dirents
  try {
    dirents = await readdir(absolute, { withFileTypes: true })
  } catch (error: unknown) {
    throw new WorkspaceIoError('unreadable', `cannot list ${JSON.stringify(relativePath ?? '')}: ${messageOf(error)}`, relativePath ?? '')
  }
  const visible = dirents.filter(dirent => showHidden || !isHidden(dirent.name))
  const entries: FileBrowserEntry[] = []
  for (const dirent of visible) {
    const childAbsolute = join(absolute, dirent.name)
    const entry = await describeEntry(root, childAbsolute)
    if (entry !== undefined) entries.push(entry)
  }
  const truncated = entries.length > limits.listLimit
  return {
    path: toRelative(root, absolute),
    entries: sortEntries(entries).slice(0, limits.listLimit),
    truncated,
  }
}

/** Describe one child, resolving a symlink's kind and skipping what cannot be described. */
async function describeEntry(root: string, absolute: string): Promise<FileBrowserEntry | undefined> {
  const info = await statOrUndefined(absolute)
  // A broken symlink has no followable target: it is neither listable nor
  // openable, so it is left out rather than shown as a row that always fails.
  if (info === undefined) return undefined
  const kind = info.isDirectory() ? 'directory' : 'file'
  if (kind === 'file') {
    return { name: basename(absolute), path: toRelative(root, absolute), kind, size: info.size }
  }
  return { name: basename(absolute), path: toRelative(root, absolute), kind }
}

/** Directories before files, each name-sorted, so the tree order is stable across hosts. */
function sortEntries(entries: readonly FileBrowserEntry[]): FileBrowserEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

/**
 * Read one file as the browser should present it: text with a version token,
 * an image reference, or a reported refusal.
 * @param root - absolute workspace root.
 * @param relativePath - workspace-relative file path.
 * @param limits - size bound.
 * @returns the content arm describing this file.
 * @throws {WorkspaceIoError} `not-found`, `unreadable`, or `unsupported` for a directory.
 */
export async function readFileContent(
  root: string,
  relativePath: string,
  limits: WorkspaceIoLimits,
  assetUrl: (relativePath: string) => string,
): Promise<FileBrowserContent> {
  const absolute = await contained(root, relativePath)
  const info = await statOrUndefined(absolute)
  if (info === undefined) {
    throw new WorkspaceIoError('not-found', `no such file: ${JSON.stringify(relativePath)}`, relativePath)
  }
  if (info.isDirectory()) {
    throw new WorkspaceIoError('unsupported', `not a file: ${JSON.stringify(relativePath)}`, relativePath)
  }
  const mediaType = imageMediaTypeOf(relativePath)
  if (mediaType !== undefined) {
    return { kind: 'image', mediaType, size: info.size, url: assetUrl(relativePath) }
  }
  if (info.size > limits.maxFileBytes) {
    return { kind: 'too-large', size: info.size, limit: limits.maxFileBytes }
  }
  const bytes = await readBytesOrThrow(absolute, relativePath)
  if (!isUtf8Text(bytes)) return { kind: 'binary', size: info.size }
  return { kind: 'text', text: bytes.toString('utf8'), version: versionOf(info), size: info.size }
}

/**
 * Read one image's bytes for the bytes route.
 * @param root - absolute workspace root.
 * @param relativePath - workspace-relative image path.
 * @param maxBytes - inclusive byte ceiling.
 * @returns the media type and raw bytes.
 * @throws {WorkspaceIoError} `not-found`, `unsupported` when the name is not an image kind, or `unsupported` when the file exceeds `maxBytes`.
 */
export async function readImageBytes(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<{ mediaType: FileBrowserImageMediaType; bytes: Buffer }> {
  const mediaType = imageMediaTypeOf(relativePath)
  if (mediaType === undefined) {
    throw new WorkspaceIoError('unsupported', `not an image kind: ${JSON.stringify(relativePath)}`, relativePath)
  }
  const absolute = await contained(root, relativePath)
  const info = await statOrUndefined(absolute)
  if (info === undefined || info.isDirectory()) {
    throw new WorkspaceIoError('not-found', `no such file: ${JSON.stringify(relativePath)}`, relativePath)
  }
  if (info.size > maxBytes) {
    throw new WorkspaceIoError('unsupported', `image exceeds ${String(maxBytes)} bytes`, relativePath)
  }
  return { mediaType, bytes: await readBytesOrThrow(absolute, relativePath) }
}

/**
 * Write a file atomically, optionally refusing a target that changed since the
 * caller read it.
 * @param root - absolute workspace root.
 * @param relativePath - workspace-relative file path.
 * @param content - the full new content.
 * @param version - the token the caller read; omitted writes unconditionally.
 * @param limits - size bound applied to the new content.
 * @returns the version the write produced.
 * @throws {WorkspaceIoError} `not-found`/`outside-workspace`, `stale` on a version mismatch, `unsupported` when the target is a directory or the content exceeds the bound.
 */
export async function writeFileContent(
  root: string,
  relativePath: string,
  content: string,
  version: string | undefined,
  limits: WorkspaceIoLimits,
): Promise<string> {
  const absolute = await contained(root, relativePath)
  const byteLength = Buffer.byteLength(content, 'utf8')
  if (byteLength > limits.maxFileBytes) {
    throw new WorkspaceIoError('unsupported', `content exceeds ${String(limits.maxFileBytes)} bytes`, relativePath)
  }
  const info = await statOrUndefined(absolute)
  if (info?.isDirectory() === true) {
    throw new WorkspaceIoError('unsupported', `not a file: ${JSON.stringify(relativePath)}`, relativePath)
  }
  if (version !== undefined) {
    // A guarded write needs a target to compare against: an absent one cannot
    // match any token, so it is a stale write rather than an unguarded create.
    if (info === undefined) {
      throw new WorkspaceIoError('stale', `no such file to replace: ${JSON.stringify(relativePath)}`, relativePath)
    }
    if (versionOf(info) !== version) {
      throw new WorkspaceIoError('stale', `file changed since it was read: ${JSON.stringify(relativePath)}`, relativePath)
    }
  }
  await publishAtomically(absolute, content)
  const written = await statOrUndefined(absolute)
  // The rename just placed the file, so a missing stat is a host fault rather
  // than a state the caller can act on; an empty token keeps the next guarded
  // write honest by refusing to match it.
  return written === undefined ? '' : versionOf(written)
}

/**
 * Create one file or directory inside an existing directory.
 * @param root - absolute workspace root.
 * @param directory - workspace-relative parent; empty means the root.
 * @param name - single non-blank path segment.
 * @param kind - file or directory.
 * @returns the created entry's workspace-relative path.
 * @throws {WorkspaceIoError} `invalid-name`, `exists`, `not-found`.
 */
export async function createEntry(
  root: string,
  directory: string | undefined,
  name: string,
  kind: 'file' | 'directory',
): Promise<string> {
  assertSegment(name)
  const parent = await contained(root, directory)
  const parentInfo = await statOrUndefined(parent)
  if (parentInfo === undefined || !parentInfo.isDirectory()) {
    throw new WorkspaceIoError('not-found', `no such directory: ${JSON.stringify(directory ?? '')}`, directory ?? '')
  }
  const target = await containedAbsolute(root, join(parent, name), toRelative(root, join(parent, name)))
  if (await statOrUndefined(target) !== undefined) {
    throw new WorkspaceIoError('exists', `already exists: ${JSON.stringify(name)}`, toRelative(root, target))
  }
  if (kind === 'directory') await mkdir(target)
  else await writeFile(target, '', { flag: 'wx' })
  return toRelative(root, target)
}

/**
 * Rename one entry within its own directory.
 * @param root - absolute workspace root.
 * @param relativePath - workspace-relative entry path.
 * @param name - single non-blank path segment replacing the base name.
 * @returns the entry's workspace-relative path after the move.
 * @throws {WorkspaceIoError} `invalid-name`, `not-found`, `exists`.
 */
export async function renameEntry(root: string, relativePath: string, name: string): Promise<string> {
  assertSegment(name)
  const source = await contained(root, relativePath)
  if (await statOrUndefined(source) === undefined) {
    throw new WorkspaceIoError('not-found', `no such entry: ${JSON.stringify(relativePath)}`, relativePath)
  }
  const target = await contained(root, join(dirname(relativePath), name))
  if (await statOrUndefined(target) !== undefined) {
    throw new WorkspaceIoError('exists', `already exists: ${JSON.stringify(name)}`, toRelative(root, target))
  }
  await rename(source, target)
  return toRelative(root, target)
}

/**
 * Delete one file or directory, recursively for a directory.
 * @param root - absolute workspace root.
 * @param relativePath - workspace-relative entry path; the root itself is refused.
 * @throws {WorkspaceIoError} `not-found`, `unsupported` when the target is the workspace root.
 */
export async function deleteEntry(root: string, relativePath: string): Promise<void> {
  const absolute = await contained(root, relativePath)
  if (absolute === await containPath(root, root)) {
    throw new WorkspaceIoError('unsupported', 'the workspace root cannot be deleted', relativePath)
  }
  if (await statOrUndefined(absolute) === undefined) {
    throw new WorkspaceIoError('not-found', `no such entry: ${JSON.stringify(relativePath)}`, relativePath)
  }
  await rm(absolute, { recursive: true, force: false })
}

/** One workspace operation's bounded name search, excluding hidden trees. */
export interface SearchOptions {
  readonly showHidden: boolean
}

/**
 * Search entry names under the workspace root.
 * @param root - absolute workspace root.
 * @param query - case-insensitive name fragment; a blank query matches nothing.
 * @param limits - result bound.
 * @param options - whether hidden trees are walked.
 * @returns the matches with a truncation flag.
 * @throws {WorkspaceIoError} `outside-workspace` when the root itself cannot be resolved.
 */
export async function searchNames(
  root: string,
  query: string,
  limits: WorkspaceIoLimits,
  options: SearchOptions,
): Promise<FileBrowserSearchResult> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { matches: [], truncated: false }
  const canonicalRoot = await containPath(root, root)
  const matches: FileBrowserSearchMatch[] = []
  let truncated = false
  const pending: string[] = [canonicalRoot]
  while (pending.length > 0 && !truncated) {
    const current = pending.pop() as string
    let dirents
    try {
      dirents = await readdir(current, { withFileTypes: true })
    } catch {
      // A directory that vanished or is unreadable mid-walk contributes no
      // matches; the walk continues with the levels it can still read.
      continue
    }
    for (const dirent of dirents) {
      if (!options.showHidden && isHidden(dirent.name)) continue
      const child = join(current, dirent.name)
      const info = await statOrUndefined(child)
      if (info === undefined) continue
      const kind = info.isDirectory() ? 'directory' : 'file'
      if (dirent.name.toLowerCase().includes(needle)) {
        if (matches.length >= limits.searchLimit) {
          truncated = true
          break
        }
        matches.push({ path: toRelative(canonicalRoot, child), kind })
      }
      if (kind === 'directory') pending.push(child)
    }
  }
  return { matches, truncated }
}

/**
 * The image media type a workspace-relative name denotes, by extension.
 * @param relativePath - workspace-relative path.
 * @returns the media type, or undefined when the name is not an image kind.
 */
export function imageMediaTypeOf(relativePath: string): FileBrowserImageMediaType | undefined {
  const lower = basename(relativePath).toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return undefined
  return IMAGE_MEDIA_TYPES[lower.slice(dot)]
}

/**
 * The freshness token of a file: modification time and size together, which is
 * what changes when another writer replaces the content.
 * @param info - the file's metadata.
 * @returns the opaque token a guarded write compares against.
 */
export function versionOf(info: { mtimeMs: number; size: number }): string {
  return `${String(info.mtimeMs)}:${String(info.size)}`
}

/** Reject anything that is not a single non-blank path segment. */
function assertSegment(name: string): void {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
    throw new WorkspaceIoError('invalid-name', `not a single path segment: ${JSON.stringify(name)}`, name)
  }
}

/** Stat without following a missing target into a throw. */
async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path, { bigint: false })
  } catch {
    // Absence is the ordinary answer for "is it there": callers branch on the
    // undefined, and a genuine permission fault surfaces at the operation that
    // actually needed the entry.
    return undefined
  }
}

/** Read a file's bytes, mapping a refused read onto the wire failure. */
async function readBytesOrThrow(absolute: string, relativePath: string): Promise<Buffer> {
  try {
    return await readFile(absolute)
  } catch (error: unknown) {
    throw new WorkspaceIoError('unreadable', `cannot read ${JSON.stringify(relativePath)}: ${messageOf(error)}`, relativePath)
  }
}

/**
 * Whether a byte sample decodes as UTF-8 text.
 *
 * A NUL byte is the classic binary marker. The decode then has to distinguish
 * two ways a trailing multi-byte sequence can be incomplete:
 *
 * - The sample is a PREFIX of a larger file, so the cut itself may have split a
 *   character. Streaming mode holds that partial sequence back instead of
 *   reporting it, which is what keeps an ordinary UTF-8 file from being called
 *   binary just because byte 8192 landed mid-character.
 * - The sample IS the whole file, so an incomplete sequence at the end is
 *   genuinely truncated content, not a boundary artifact. A strict decode
 *   reports it, which is what keeps malformed data out of the editor.
 *
 * @param bytes - the whole file (only the leading sample is examined).
 * @returns true when the sample is decodable text.
 */
function isUtf8Text(bytes: Buffer): boolean {
  const truncated = bytes.byteLength > SNIFF_BYTES
  const sample = bytes.subarray(0, SNIFF_BYTES)
  if (sample.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, truncated ? { stream: true } : undefined)
    return true
  } catch {
    return false
  }
}

/**
 * Publish `content` at `absolute` atomically: a uniquely named temporary file in
 * the same directory, then a rename. Same-directory placement is what keeps the
 * rename from crossing a device, where it would stop being atomic.
 */
async function publishAtomically(absolute: string, content: string): Promise<void> {
  const temporary = join(dirname(absolute), `.${basename(absolute)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, absolute)
  } catch (error: unknown) {
    // Best-effort cleanup: the rename either consumed the temporary or failed,
    // and a leftover temp file must not survive a refused write.
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** One line of diagnostic text from a caught value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
