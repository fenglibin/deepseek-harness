/**
 * Filesystem-truth skill management.
 *
 * The discovery registry answers which skill wins for one agent; this service
 * answers what is on disk. A management surface needs the second: every
 * scanned root, duplicate names that lose to a higher-precedence root, files
 * whose frontmatter discovery drops, and the absolute path an edit targets.
 * Writes resolve their destination through `ctx.skillRoots`, so a skill
 * created here is a skill the next discovery pass reads.
 * @module @deepseek-ai/dsh-host-skill-manager
 */

import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillRootInfo } from '@deepseek-ai/dsh-skill-filesystem'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import {
  editSkillFrontmatter,
  parseSkillFrontmatter,
  removeSkillFrontmatterKeys,
  renderSkillDocument,
} from './frontmatter.ts'
import { type UnpackedEntry, type UnpackLimits } from './import/archive.ts'
import { planArchiveBytes, planImport, type ImportFetch } from './import/source.ts'
import { ImportStaging, type ImportPreviewId as StagedPreviewId } from './import/staging.ts'
import type {
  ImportCommitRequest,
  ImportFilePreview,
  ImportPreview,
  ImportPreviewId,
  ImportPreviewFile,
  ImportPreviewFileRequest,
  ImportPreviewRequest,
  SkillAdminEntry,
  SkillAdminListRequest,
  SkillAdminSnapshot,
  SkillCreateRequest,
  SkillDeleteRequest,
  SkillDocument,
  SkillEntryForm,
  SkillEntryId,
  SkillFileDocument,
  SkillFileListRequest,
  SkillFileNode,
  SkillFileReadRequest,
  SkillFileTree,
  SkillFileWriteRequest,
  SkillInvocationPolicy,
  SkillReadRequest,
  SkillRootView,
  SkillSetEnabledRequest,
  SkillUpdateRequest,
  SkillUploadRequest,
} from './types.ts'

export type * from './types.ts'

/** Filename a directory-bundle skill is addressed by. */
const BUNDLE_ENTRY = 'SKILL.md'

/** Permission bits stamped on a written skill file. */
const FILE_MODE = 0o644

/** Why a root this deployment ships refuses writes. */
const BUNDLED_READ_ONLY = 'bundled skill root ships with the deployment'

/** Directory inside one root where disabled entries are parked out of discovery's reach. */
const DISABLED_DIR = '.disabled'

/** Largest file the editor reads or writes, in bytes. */
const FILE_MAX_BYTES = 512 * 1024

/** Members one entry's file tree lists before the walk stops. */
const FILE_LIST_MAX_ENTRIES = 512

/** Directory levels below an entry's file root the walk descends. */
const FILE_LIST_MAX_DEPTH = 6

/** Largest uploaded archive accepted before base64 expansion, in bytes. */
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No scanned root carries the requested path. */
    'skill-admin/root-not-found': { readonly rootPath: string }
    /** The named root exists but this deployment refuses writes into it. */
    'skill-admin/root-not-writable': { readonly rootPath: string; readonly reason: string }
    /** No scanned root contains the addressed entry. */
    'skill-admin/entry-not-found': { readonly entryId: string }
    /** An entry already occupies the requested name in the target root. */
    'skill-admin/entry-exists': { readonly path: string }
    /** The requested skill name is not kebab-case. */
    'skill-admin/invalid-name': { readonly name: string }
    /** The addressed file carries no frontmatter block this surface can edit. */
    'skill-admin/invalid-frontmatter': { readonly path: string; readonly reason: string }
    /** The filesystem refused a read, write, or removal. */
    'skill-admin/io-failed': { readonly path: string; readonly reason: string }
    /** The import source could not be reached. */
    'skill-admin/import-unreachable': { readonly reason: string }
    /** The import payload cannot be safely unpacked or is outside the configured bounds. */
    'skill-admin/import-unreadable': { readonly reason: string }
    /** The import carries no SKILL.md at its root. */
    'skill-admin/import-no-skill': { readonly reason: string }
    /** The approved preview expired or was already committed. */
    'skill-admin/import-expired': { readonly previewId: string }
    /** No file occupies the requested path inside the addressed entry. */
    'skill-admin/file-not-found': { readonly path: string }
    /** The addressed file refuses writes. */
    'skill-admin/file-not-writable': { readonly path: string; readonly reason: string }
    /** The requested relative path leaves the entry's file root. */
    'skill-admin/file-escapes-entry': { readonly path: string }
    /** The uploaded payload is not canonical base64. */
    'skill-admin/upload-invalid': { readonly reason: string }
  }
}

/** Bounds the importer applies to a whole archive. */
const IMPORT_LIMITS: UnpackLimits = {
  maxEntries: 512,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
}

/** Non-schema collaborators a test substitutes; production uses the defaults. */
export interface SkillManagerInternals {
  /** Transport the importer reads through. Defaults to the process fetch. */
  readonly importFetch?: ImportFetch
}

/** The process fetch, narrowed to the surface the importer needs. */
function defaultFetch(): ImportFetch {
  return (url, init) => fetch(url, init)
}

/** One scanned root with the entries it holds. */
interface ScannedRoot {
  readonly root: SkillRootInfo
  entries: SkillAdminEntry[]
}

/** Host service backing the `skillAdmin` Remote namespace. */
export class SkillManagerGateway extends TypertRemoteService {
  static inject = ['skillRoots']

  private readonly staging = new ImportStaging()
  private readonly importFetch: ImportFetch

  /**
   * @param ctx - Host context carrying the injected skill-root view.
   * @param internals - transport override; production reads through the process fetch.
   */
  constructor(ctx: Context, internals: SkillManagerInternals = {}) {
    super(ctx, 'skillManager', { namespace: 'skillAdmin' })
    this.importFetch = internals.importFetch ?? defaultFetch()
  }

  /**
   * Read the management view of one workspace: every scanned root, every
   * entry it holds, and which same-name entry a lower rank shadows.
   * @param request - workspace selection; an absent `projectRoot` lists global roots alone.
   * @returns roots in precedence order, each with its entries.
   */
  @Remote('list')
  async list(request: SkillAdminListRequest): Promise<SkillAdminSnapshot> {
    const scanned = await this.scanned(request.projectRoot)
    return {
      ...request.projectRoot === undefined ? {} : { projectRoot: request.projectRoot },
      roots: scanned.map(viewOf),
    }
  }

  /**
   * Read one entry's complete file for editing.
   * @param request - the entry to read.
   * @returns the entry's verbatim file text beside its parsed frontmatter fields.
   * @throws {RemoteError} `skill-admin/entry-not-found` when the path is
   * unreadable, `skill-admin/invalid-frontmatter` when its block is unusable,
   * or `skill-admin/io-failed` when reading fails for another reason.
   */
  @Remote('read')
  async read(request: SkillReadRequest): Promise<SkillDocument> {
    const path = String(request.entryId)
    const raw = await this.readText(path)
    const block = parseSkillFrontmatter(raw)
    if (block === undefined) {
      throw new RemoteError('skill-admin/invalid-frontmatter', `skill file ${path} has no usable frontmatter block`, {
        path,
        reason: 'missing or unparsable frontmatter',
      })
    }
    const whenToUse = stringValue(block.data.whenToUse)
    return {
      entryId: request.entryId,
      path,
      form: formOf(path),
      raw,
      content: block.body.trim(),
      name: stringValue(block.data.name) ?? basename(path, '.md'),
      description: stringValue(block.data.description) ?? '',
      ...whenToUse === undefined ? {} : { whenToUse },
      invocation: invocationOf(block.data),
    }
  }

  /**
   * Create one skill entry under a scanned root.
   * @param request - target root, name, frontmatter fields, body, and on-disk form.
   * @returns the scanned entry that now exists.
   * @throws {RemoteError} `skill-admin/invalid-name` for a non-kebab-case name,
   * `skill-admin/root-not-found` for a path outside the scanned set,
   * `skill-admin/root-not-writable` for a read-only root,
   * `skill-admin/entry-exists` when the target is occupied, or
   * `skill-admin/io-failed` when the write fails.
   */
  @Remote('create')
  async create(request: SkillCreateRequest): Promise<SkillAdminEntry> {
    if (!isSkillName(request.name)) {
      throw new RemoteError('skill-admin/invalid-name', `skill name ${JSON.stringify(request.name)} is not kebab-case`, {
        name: request.name,
      })
    }
    const scanned = await this.scanned(request.projectRoot)
    const target = scanned.find(candidate => candidate.root.path === request.rootPath)
    if (target === undefined) {
      throw new RemoteError('skill-admin/root-not-found', `no scanned skill root ${JSON.stringify(request.rootPath)}`, {
        rootPath: request.rootPath,
      })
    }
    if (target.root.readOnly) {
      throw new RemoteError('skill-admin/root-not-writable', `skill root ${JSON.stringify(request.rootPath)} refuses writes`, {
        rootPath: request.rootPath,
        reason: BUNDLED_READ_ONLY,
      })
    }
    const path = request.form === 'bundle'
      ? join(request.rootPath, request.name, BUNDLE_ENTRY)
      : join(request.rootPath, `${request.name}.md`)
    if (await exists(path)) {
      throw new RemoteError('skill-admin/entry-exists', `skill entry ${JSON.stringify(path)} already exists`, { path })
    }
    await this.write(path, renderSkillDocument([
      ['name', request.name],
      ...frontmatterFields(request),
    ], request.content))
    return await this.requireScanned(request.projectRoot, path)
  }

  /**
   * Rewrite one entry's frontmatter fields and body, keeping every comment and
   * every key the request does not name.
   * @param request - the entry plus the fields and body to write.
   * @returns the rescanned entry.
   * @throws {RemoteError} `skill-admin/entry-not-found` when no scanned root
   * contains the entry, `skill-admin/root-not-writable` for a read-only root,
   * `skill-admin/invalid-frontmatter` when the file cannot be edited in place,
   * or `skill-admin/io-failed` when the write fails.
   */
  @Remote('update')
  async update(request: SkillUpdateRequest): Promise<SkillAdminEntry> {
    const path = String(request.entryId)
    const scanned = await this.scanned(request.projectRoot)
    const owner = ownerOf(scanned, path)
    if (owner === undefined) {
      throw new RemoteError('skill-admin/entry-not-found', `no scanned skill root contains ${JSON.stringify(path)}`, {
        entryId: path,
      })
    }
    if (owner.readOnly) {
      throw new RemoteError('skill-admin/root-not-writable', `skill root ${JSON.stringify(owner.path)} refuses writes`, {
        rootPath: owner.path,
        reason: BUNDLED_READ_ONLY,
      })
    }
    const raw = await this.readText(path)
    let next: string
    try {
      next = editSkillFrontmatter(raw, frontmatterFields(request))
      if (request.whenToUse === undefined) next = removeSkillFrontmatterKeys(next, ['whenToUse'])
    } catch (error: unknown) {
      throw new RemoteError('skill-admin/invalid-frontmatter', `skill file ${path} cannot be edited in place`, {
        path,
        reason: String(error),
      })
    }
    const block = parseSkillFrontmatter(next)
    /* v8 ignore next 6 -- defensive: editSkillFrontmatter either throws or returns text whose block it just re-read, and every rendered line is `key: value`, so a successful edit cannot drop the block. */
    if (block === undefined) {
      throw new RemoteError('skill-admin/invalid-frontmatter', `skill file ${path} lost its frontmatter block`, {
        path,
        reason: 'frontmatter block not found after edit',
      })
    }
    const bodyStart = next.length - block.body.length
    const body = request.content.trim()
    await this.write(path, `${next.slice(0, bodyStart)}${body.length === 0 ? '' : `\n${body}\n`}`)
    return await this.requireScanned(request.projectRoot, path)
  }

  /**
   * Delete one entry. A directory bundle is deleted with everything it holds.
   * @param request - the entry to delete.
   * @returns nothing once the entry is gone.
   * @throws {RemoteError} `skill-admin/entry-not-found` when no scanned root
   * contains the entry, `skill-admin/root-not-writable` for a read-only root,
   * or `skill-admin/io-failed` when deletion fails.
   */
  @Remote('delete')
  async delete(request: SkillDeleteRequest): Promise<void> {
    const path = String(request.entryId)
    const scanned = await this.scanned(request.projectRoot)
    const owner = ownerOf(scanned, path)
    if (owner === undefined) {
      throw new RemoteError('skill-admin/entry-not-found', `no scanned skill root contains ${JSON.stringify(path)}`, {
        entryId: path,
      })
    }
    if (owner.readOnly) {
      throw new RemoteError('skill-admin/root-not-writable', `skill root ${JSON.stringify(owner.path)} refuses writes`, {
        rootPath: owner.path,
        reason: BUNDLED_READ_ONLY,
      })
    }
    const target = formOf(path) === 'bundle' ? dirname(path) : path
    try {
      await rm(target, { recursive: true, force: false })
    } catch (error: unknown) {
      if (isAbsent(error)) {
        throw new RemoteError('skill-admin/entry-not-found', `skill entry ${JSON.stringify(path)} does not exist`, {
          entryId: path,
        })
      }
      /* v8 ignore next 4 -- unreachable on a writable temporary tree: every removable path is either absent (ENOENT/ENOTDIR) or removable, and the remaining permission failures need a foreign owner the suite cannot create portably. */
      throw new RemoteError('skill-admin/io-failed', `could not remove ${JSON.stringify(target)}`, {
        path: target,
        reason: String(error),
      })
    }
  }

  /**
   * Resolve an import source into the exact file list a commit would write,
   * without writing anything.
   * @param request - the source and the scanned root it would be written under.
   * @returns the preview, including the incoming SKILL.md body the reader judges.
   * @throws {RemoteError} `skill-admin/root-not-found` or
   * `skill-admin/root-not-writable` for an unusable target root, or the
   * `skill-admin/import-*` failures the resolver raises.
   */
  @Remote('previewImport')
  async previewImport(request: ImportPreviewRequest): Promise<ImportPreview> {
    await this.writableRoot(request.rootPath, request.projectRoot)
    const plan = await planImport({ source: request.source }, this.importFetch, IMPORT_LIMITS)
    return await this.previewOf(plan.files, plan.origin, request.rootPath, request.projectRoot)
  }

  /**
   * Validate one resolved file list and stage it for a commit.
   *
   * Every import source reaches the preview through here, so a reader approves
   * the same shape of evidence whether the files arrived by URL or by upload.
   * @param files - the unpacked members the preview reports.
   * @param origin - human-readable source the preview shows.
   * @param rootPath - the scanned root a commit would write under.
   * @param projectRoot - workspace whose project roots located that root.
   * @returns the preview a reader approves.
   * @throws {RemoteError} `skill-admin/import-no-skill` when the entry point is
   * missing or unusable.
   */
  private async previewOf(
    files: readonly UnpackedEntry[],
    origin: string,
    rootPath: string,
    projectRoot: string | undefined,
  ): Promise<ImportPreview> {
    const block = parseSkillFrontmatter(utf8(skillFileBytes(files)))
    if (block === undefined) {
      throw new RemoteError('skill-admin/import-no-skill', 'the imported SKILL.md carries no frontmatter block', {
        reason: 'missing or unparsable frontmatter',
      })
    }
    const name = stringValue(block.data.name)
    const description = stringValue(block.data.description)
    if (name === undefined || !isSkillName(name)) {
      throw new RemoteError('skill-admin/import-no-skill', 'the imported SKILL.md carries no usable kebab-case name', {
        reason: 'frontmatter requires a kebab-case name',
      })
    }
    // Discovery drops a skill whose frontmatter lacks a description, so an
    // import that would write an unusable entry is refused here instead of
    // leaving the reader with a skill the agent silently never sees.
    if (description === undefined) {
      throw new RemoteError('skill-admin/import-no-skill', 'the imported SKILL.md carries no description', {
        reason: 'frontmatter requires a description',
      })
    }
    const targetPath = join(rootPath, name)
    const previewId = this.staging.stage({
      files,
      origin,
      rootPath,
      ...projectRoot === undefined ? {} : { projectRoot },
    }) as unknown as ImportPreviewId
    return {
      previewId,
      origin,
      rootPath,
      targetPath,
      name,
      description,
      content: block.body.trim(),
      files: files.map(file => ({ path: file.path, bytes: file.bytes.byteLength } satisfies ImportFilePreview)),
      totalBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
      replaces: await exists(targetPath),
    }
  }

  /**
   * Write one preview that was approved.
   * @param request - identity of the preview to write.
   * @returns nothing once every file is on disk.
   * @throws {RemoteError} `skill-admin/import-expired` when the preview is gone,
   * `skill-admin/entry-exists` when the target is already occupied — the write
   * never replaces an existing entry — or `skill-admin/io-failed` when a write fails.
   */
  @Remote('commitImport')
  async commitImport(request: ImportCommitRequest): Promise<void> {
    const previewId = String(request.previewId)
    const staged = this.staging.take(previewId as StagedPreviewId)
    if (staged === undefined) {
      throw new RemoteError('skill-admin/import-expired', `import preview ${JSON.stringify(previewId)} is no longer available`, {
        previewId,
      })
    }
    await this.writableRoot(staged.rootPath, staged.projectRoot)
    const skillBlock = parseSkillFrontmatter(utf8(skillFileBytes(staged.files)))
    const name = stringValue(skillBlock?.data.name)
    if (name === undefined || !isSkillName(name)) {
      throw new RemoteError('skill-admin/import-no-skill', 'the staged SKILL.md carries no usable kebab-case name', {
        reason: 'frontmatter requires a kebab-case name',
      })
    }
    const targetPath = join(staged.rootPath, name)
    // Importing over an existing entry is refused rather than merged: the
    // target may hold files this import knows nothing about.
    if (await exists(targetPath)) {
      throw new RemoteError('skill-admin/entry-exists', `skill entry ${JSON.stringify(targetPath)} already exists`, {
        path: targetPath,
      })
    }
    for (const file of staged.files) {
      const destination = join(targetPath, file.path)
      // Re-checked at the write rather than trusted from staging: staging is
      // an in-memory object that several call paths could have produced, and
      // this is the last point where a path leaving the skill directory can
      // still be refused.
      if (!contains(targetPath, destination)) {
        throw new RemoteError('skill-admin/import-unreadable', `import member ${JSON.stringify(file.path)} leaves the skill directory`, {
          reason: `resolved to ${JSON.stringify(destination)}`,
        })
      }
      await this.write(destination, utf8(file.bytes))
    }
  }

  /**
   * Move one entry between discovery's reach and its root's disabled parking
   * directory.
   * @param request - the entry and the state it should end up in.
   * @returns the rescanned entry at its new location.
   * @throws {RemoteError} `skill-admin/entry-not-found` when no scanned root
   * contains the entry, `skill-admin/root-not-writable` for a read-only root,
   * `skill-admin/entry-exists` when the destination is already occupied, or
   * `skill-admin/io-failed` when the move fails.
   */
  @Remote('setEnabled')
  async setEnabled(request: SkillSetEnabledRequest): Promise<SkillAdminEntry> {
    const path = String(request.entryId)
    const scanned = await this.scanned(request.projectRoot)
    const owner = ownerOf(scanned, path)
    if (owner === undefined) {
      throw new RemoteError('skill-admin/entry-not-found', `no scanned skill root contains ${JSON.stringify(path)}`, {
        entryId: path,
      })
    }
    if (owner.readOnly) {
      throw new RemoteError('skill-admin/root-not-writable', `skill root ${JSON.stringify(owner.path)} refuses writes`, {
        rootPath: owner.path,
        reason: BUNDLED_READ_ONLY,
      })
    }
    const form = formOf(path)
    const name = form === 'bundle' ? basename(dirname(path)) : basename(path, '.md')
    const source = form === 'bundle' ? dirname(path) : path
    const target = entryLocation(owner.path, name, form, request.enabled)
    // Naming the state the entry already holds is a no-op rather than a
    // conflict, so a toggle re-sent after a lost response stays idempotent.
    if (source !== target) {
      if (await exists(target)) {
        throw new RemoteError('skill-admin/entry-exists', `skill entry ${JSON.stringify(target)} already exists`, {
          path: target,
        })
      }
      await this.move(source, target)
    }
    return await this.requireScanned(request.projectRoot, entryFile(target, form))
  }

  /**
   * List every file one entry holds, for the editor's tree.
   * @param request - the entry to walk.
   * @returns the entry's file root and the files below it, in path order.
   * @throws {RemoteError} `skill-admin/entry-not-found` when no scanned root
   * contains the entry.
   */
  @Remote('listFiles')
  async listFiles(request: SkillFileListRequest): Promise<SkillFileTree> {
    const { entry } = await this.requireOwned(request.projectRoot, String(request.entryId))
    // A flat skill shares its root with every sibling skill, so the files it
    // owns are the one file it is addressed by rather than that directory.
    if (entry.form === 'flat') {
      const info = await stat(entry.path)
      return {
        entryId: entry.entryId,
        directory: entry.directory,
        files: [{ path: basename(entry.path), bytes: info.size }],
        truncated: false,
      }
    }
    const walk = await walkFiles(entry.directory)
    return { entryId: entry.entryId, directory: entry.directory, files: walk.files, truncated: walk.truncated }
  }

  /**
   * Read one file of one entry as text.
   * @param request - the entry and the file within it.
   * @returns the file text, or a read-only document when the file cannot be edited.
   * @throws {RemoteError} `skill-admin/entry-not-found` when no scanned root
   * contains the entry, `skill-admin/file-escapes-entry` when the relative path
   * leaves the entry's file root, or `skill-admin/file-not-found` when nothing
   * occupies it.
   */
  @Remote('readFile')
  async readFile(request: SkillFileReadRequest): Promise<SkillFileDocument> {
    const { entry } = await this.requireOwned(request.projectRoot, String(request.entryId))
    const bytes = await this.readBytes(entryFilePath(entry, request.path))
    return fileDocument(entry, request.path, bytes)
  }

  /**
   * Rewrite one file of one entry.
   * @param request - the entry, the file within it, and the replacement text.
   * @returns nothing once the file is written.
   * @throws {RemoteError} `skill-admin/entry-not-found` when no scanned root
   * contains the entry, `skill-admin/root-not-writable` for a read-only root,
   * `skill-admin/file-escapes-entry` when the relative path leaves the entry,
   * `skill-admin/file-not-writable` for a file the editor cannot replace, or
   * `skill-admin/invalid-frontmatter` when the entry point would lose the name
   * or description discovery requires.
   */
  @Remote('writeFile')
  async writeFile(request: SkillFileWriteRequest): Promise<void> {
    const { entry, root } = await this.requireOwned(request.projectRoot, String(request.entryId))
    if (root.readOnly) {
      throw new RemoteError('skill-admin/root-not-writable', `skill root ${JSON.stringify(root.path)} refuses writes`, {
        rootPath: root.path,
        reason: BUNDLED_READ_ONLY,
      })
    }
    const target = entryFilePath(entry, request.path)
    const current = await this.readBytes(target)
    // The read is repeated here rather than trusted from a prior readFile: the
    // editor's decision to allow typing is a client-side fact, and this is the
    // point where a write actually happens.
    if (current.byteLength > FILE_MAX_BYTES || current.includes(0)) {
      throw new RemoteError('skill-admin/file-not-writable', `skill file ${JSON.stringify(target)} is read-only`, {
        path: target,
        reason: current.byteLength > FILE_MAX_BYTES ? 'the file exceeds the editable size limit' : 'the file is not text',
      })
    }
    // The entry point is the file discovery reads for a skill's identity, and it
    // is a bundle's SKILL.md or a flat skill's only file. Keying the check on
    // the basename alone would leave a flat skill free to lose its own name and
    // description, which discovery answers by silently dropping the skill.
    if (target === entry.path) requireUsableFrontmatter(request.text, target)
    await this.write(target, request.text)
  }

  /**
   * Resolve an uploaded archive into the exact file list a commit would write.
   * @param request - the uploaded bytes and the scanned root they would be written under.
   * @returns the preview, including the incoming SKILL.md body the reader judges.
   * @throws {RemoteError} `skill-admin/upload-invalid` for a non-canonical
   * payload or one beyond the upload bound, `skill-admin/root-not-found` or
   * `skill-admin/root-not-writable` for an unusable target root, or the
   * `skill-admin/import-*` failures the unpacker raises.
   */
  @Remote('previewUpload')
  async previewUpload(request: SkillUploadRequest): Promise<ImportPreview> {
    await this.writableRoot(request.rootPath, request.projectRoot)
    const bytes = decodeUpload(request.data)
    const plan = planArchiveBytes(bytes, request.fileName, IMPORT_LIMITS, `upload:${request.fileName}`)
    return await this.previewOf(plan.files, plan.origin, request.rootPath, request.projectRoot)
  }

  /**
   * Read one file of a staged preview, so a reader can inspect what they are
   * about to write before approving it.
   * @param request - the staged preview and the member to read.
   * @returns the member's text, or a marker saying why it has none.
   * @throws {RemoteError} `skill-admin/import-expired` when the preview is gone,
   * or `skill-admin/file-not-found` when it holds no such member.
   */
  @Remote('readPreviewFile')
  async readPreviewFile(request: ImportPreviewFileRequest): Promise<ImportPreviewFile> {
    const previewId = String(request.previewId)
    const staged = this.staging.peek(previewId as StagedPreviewId)
    if (staged === undefined) {
      throw new RemoteError('skill-admin/import-expired', `import preview ${JSON.stringify(previewId)} is no longer available`, {
        previewId,
      })
    }
    const member = staged.files.find(file => file.path === request.path)
    if (member === undefined) {
      throw new RemoteError('skill-admin/file-not-found', `import preview ${JSON.stringify(previewId)} holds no ${JSON.stringify(request.path)}`, {
        path: request.path,
      })
    }
    return previewFileOf(request.path, member.bytes)
  }

  /** Re-resolve one root and refuse it unless this deployment accepts writes into it. */
  private async writableRoot(rootPath: string, projectRoot: string | undefined): Promise<ScannedRoot> {
    const root = (await this.scanned(projectRoot)).find(candidate => candidate.root.path === rootPath)
    if (root === undefined) {
      throw new RemoteError('skill-admin/root-not-found', `no scanned skill root ${JSON.stringify(rootPath)}`, { rootPath })
    }
    if (root.root.readOnly) {
      throw new RemoteError('skill-admin/root-not-writable', `skill root ${JSON.stringify(rootPath)} refuses writes`, {
        rootPath,
        reason: BUNDLED_READ_ONLY,
      })
    }
    return root
  }

  /** Scan every root one workspace selection resolves, with shadowing resolved. */
  private async scanned(projectRoot: string | undefined): Promise<ScannedRoot[]> {
    const scanned: ScannedRoot[] = []
    for (const root of await this.ctx.skillRoots.list(projectRoot)) {
      scanned.push({ root, entries: await discoverRoot(root.path) })
    }
    applyShadowing(scanned)
    return scanned
  }

  /** Rescan and return one written entry, failing loud when it is not discoverable. */
  private async requireScanned(projectRoot: string | undefined, path: string): Promise<SkillAdminEntry> {
    const found = await this.findEntry(projectRoot, path)
    if (found === undefined) {
      throw new RemoteError('skill-admin/io-failed', `skill entry ${JSON.stringify(path)} was written but not discovered`, {
        path,
        reason: 'written entry not discovered',
      })
    }
    return found
  }

  /** Resolve one scanned entry together with the root that holds it. */
  private async requireOwned(
    projectRoot: string | undefined,
    path: string,
  ): Promise<{ entry: SkillAdminEntry; root: SkillRootInfo }> {
    const scanned = await this.scanned(projectRoot)
    const entry = scanned.flatMap(root => root.entries).find(candidate => candidate.path === path)
    const root = ownerOf(scanned, path)
    if (entry === undefined || root === undefined) {
      throw new RemoteError('skill-admin/entry-not-found', `no scanned skill root contains ${JSON.stringify(path)}`, {
        entryId: path,
      })
    }
    return { entry, root }
  }

  /** Resolve one scanned entry by the file path it is addressed by. */
  private async findEntry(projectRoot: string | undefined, path: string): Promise<SkillAdminEntry | undefined> {
    return (await this.scanned(projectRoot)).flatMap(root => root.entries).find(entry => entry.path === path)
  }

  /** Move one entry within its root, creating the parking directory on first use. */
  private async move(source: string, target: string): Promise<void> {
    try {
      await mkdir(dirname(target), { recursive: true })
      await rename(source, target)
    } catch (error: unknown) {
      if (isAbsent(error)) {
        throw new RemoteError('skill-admin/entry-not-found', `skill entry ${JSON.stringify(source)} does not exist`, {
          entryId: source,
        })
      }
      throw new RemoteError('skill-admin/io-failed', `could not move ${JSON.stringify(source)}`, {
        path: source,
        reason: String(error),
      })
    }
  }

  /** Read one file, translating every filesystem failure into a Remote failure. */
  private async readText(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf8')
    } catch (error: unknown) {
      if (isAbsent(error)) {
        throw new RemoteError('skill-admin/entry-not-found', `skill entry ${JSON.stringify(path)} does not exist`, {
          entryId: path,
        })
      }
      throw new RemoteError('skill-admin/io-failed', `could not read ${JSON.stringify(path)}`, {
        path,
        reason: String(error),
      })
    }
  }

  /** Read one file's bytes, translating every filesystem failure into a Remote failure. */
  private async readBytes(path: string): Promise<Buffer> {
    try {
      return await readFile(path)
    } catch (error: unknown) {
      if (isAbsent(error)) {
        throw new RemoteError('skill-admin/file-not-found', `skill file ${JSON.stringify(path)} does not exist`, {
          path,
        })
      }
      throw new RemoteError('skill-admin/io-failed', `could not read ${JSON.stringify(path)}`, {
        path,
        reason: String(error),
      })
    }
  }

  /** Write one skill file atomically, translating failures into a Remote failure. */
  private async write(path: string, text: string): Promise<void> {
    try {
      await writeFileAtomic(path, text, { mode: FILE_MODE })
    } catch (error: unknown) {
      throw new RemoteError('skill-admin/io-failed', `could not write ${JSON.stringify(path)}`, {
        path,
        reason: String(error),
      })
    }
  }
}

export default SkillManagerGateway

/** The frontmatter fields every write states explicitly, in canonical order. */
function frontmatterFields(request: {
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
}): readonly (readonly [string, string | boolean])[] {
  return [
    ['description', request.description],
    ...request.whenToUse === undefined ? [] : [['whenToUse', request.whenToUse] as const],
    ['disable-model-invocation', !request.invocation.modelInvocable],
    ['user-invocable', request.invocation.userInvocable],
  ]
}

/** Project one scanned root into the wire view. */
function viewOf(scanned: ScannedRoot): SkillRootView {
  return {
    path: scanned.root.path,
    source: scanned.root.source,
    rank: scanned.root.rank,
    ...scanned.root.projectRoot === undefined ? {} : { projectRoot: scanned.root.projectRoot },
    writable: !scanned.root.readOnly,
    ...scanned.root.readOnly ? { readOnlyReason: BUNDLED_READ_ONLY } : {},
    entries: scanned.entries,
  }
}

/** Discover every entry one root holds: the scanned ones plus the disabled ones, in name order. */
async function discoverRoot(path: string): Promise<SkillAdminEntry[]> {
  const enabled = await discoverDirectory(path, true)
  const disabled = await discoverDirectory(join(path, DISABLED_DIR), false)
  return [...enabled, ...disabled].sort((left, right) => left.name.localeCompare(right.name))
}

/** Read the skill entries one directory holds directly, recording whether discovery reads them. */
async function discoverDirectory(path: string, enabled: boolean): Promise<SkillAdminEntry[]> {
  let dirents
  try {
    dirents = await readdir(path, { withFileTypes: true })
  } catch {
    // An absent directory is the ordinary empty state — a root that does not
    // exist yet, or a root holding nothing disabled — and a directory this
    // process cannot read lists nothing rather than failing the whole view.
    return []
  }
  const entries: SkillAdminEntry[] = []
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue
    if (dirent.isDirectory()) {
      const file = join(path, dirent.name, BUNDLE_ENTRY)
      if (await exists(file)) entries.push(await readEntry(file, dirent.name, 'bundle', enabled))
    } else if (dirent.isFile() && dirent.name.endsWith('.md') && dirent.name !== BUNDLE_ENTRY) {
      const file = join(path, dirent.name)
      entries.push(await readEntry(file, dirent.name.slice(0, -'.md'.length), 'flat', enabled))
    }
  }
  return entries
}

/** Read one skill file into the management view, recording why discovery would drop it. */
async function readEntry(
  path: string,
  fallbackName: string,
  form: SkillEntryForm,
  enabled: boolean,
): Promise<SkillAdminEntry> {
  const base = {
    entryId: entryIdOf(path),
    path,
    directory: dirname(path),
    form,
    enabled,
    shadowed: false,
  }
  const unusable = (invalid: string): SkillAdminEntry => ({
    ...base,
    name: fallbackName,
    description: '',
    invocation: { modelInvocable: true, userInvocable: true },
    invalid,
  })
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error: unknown) {
    /* v8 ignore next -- unreachable on a controlled tree: the entry was listed a moment ago, so a failure here means it vanished or became unreadable between the listing and this read, which needs a foreign writer the suite cannot stage portably. */
    return unusable(`unreadable: ${String(error)}`)
  }
  let block
  try {
    block = parseSkillFrontmatter(raw)
  } catch (error: unknown) {
    return unusable(`invalid YAML frontmatter: ${String(error)}`)
  }
  if (block === undefined) return unusable('missing YAML frontmatter')
  const name = stringValue(block.data.name)
  const description = stringValue(block.data.description)
  const whenToUse = stringValue(block.data.whenToUse)
  const common = {
    ...base,
    name: name ?? fallbackName,
    description: description ?? '',
    ...whenToUse === undefined ? {} : { whenToUse },
    invocation: invocationOf(block.data),
  }
  if (name === undefined || description === undefined) return { ...common, invalid: 'frontmatter requires name and description' }
  if (!isSkillName(name)) return { ...common, invalid: `invalid skill name ${JSON.stringify(name)}` }
  return common
}

/**
 * Mark every entry a same-name entry of lower rank wins over.
 *
 * A disabled entry is parked outside the scanned set, so it neither shadows nor
 * is shadowed: it competes for a name only once it is enabled again.
 */
function applyShadowing(scanned: ScannedRoot[]): void {
  const winnerRank = new Map<string, number>()
  for (const { root, entries } of scanned) {
    for (const entry of entries) {
      if (entry.invalid !== undefined || !entry.enabled) continue
      const held = winnerRank.get(entry.name)
      if (held === undefined || root.rank < held) winnerRank.set(entry.name, root.rank)
    }
  }
  for (const root of scanned) {
    root.entries = root.entries.map(entry => ({
      ...entry,
      shadowed: entry.invalid === undefined && entry.enabled && winnerRank.get(entry.name) !== root.root.rank,
    }))
  }
}

/** Resolve the scanned root containing one entry path. */
function ownerOf(scanned: readonly ScannedRoot[], path: string): SkillRootInfo | undefined {
  return scanned.map(candidate => candidate.root)
    .find(root => contains(root.path, path))
}

/** Whether a root directory contains a path. */
function contains(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Resolve the on-disk form a path names. */
function formOf(path: string): SkillEntryForm {
  return basename(path) === BUNDLE_ENTRY ? 'bundle' : 'flat'
}

/** Resolve the invocation policy discovery reads from one frontmatter mapping. */
function invocationOf(data: Record<string, unknown>): SkillInvocationPolicy {
  return {
    modelInvocable: data['disable-model-invocation'] !== true,
    userInvocable: data['user-invocable'] !== false,
  }
}

/** Read one frontmatter value that must be a non-empty string. */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Decode one unpacked member as UTF-8 text. */
function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Read the SKILL.md member of one import.
 * @param files - the members a resolved plan or a staged preview carries.
 * @returns the member's bytes.
 */
function skillFileBytes(files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): Uint8Array {
  const skillFile = files.find(file => file.path === 'SKILL.md')
  /* v8 ignore next 5 -- every plan and staged set reaching this helper was validated by previewImport, which refuses a payload without SKILL.md. */
  if (skillFile === undefined) {
    throw new RemoteError('skill-admin/import-no-skill', 'the import carries no SKILL.md at its root', {
      reason: 'a skill is a directory holding SKILL.md',
    })
  }
  return skillFile.bytes
}

/** Brand an entry's absolute path as its management identity. */
function entryIdOf(path: string): SkillEntryId {
  return brandString<SkillEntryId>(path)
}

/** Whether a path currently exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    // Any stat failure means the path cannot be addressed as an existing entry.
    return false
  }
}

/** Whether a failure reports an absent path. */
function isAbsent(error: unknown): boolean {
  /* v8 ignore next -- defensive: every failure this predicate sees comes from node:fs, which throws an Error carrying a string `code`; the shape guard exists so the predicate stays total for its unknown parameter. */
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Resolve where one entry lives while discovery does or does not read it. */
function entryLocation(rootPath: string, name: string, form: SkillEntryForm, enabled: boolean): string {
  const directory = enabled ? rootPath : join(rootPath, DISABLED_DIR)
  return form === 'bundle' ? join(directory, name) : join(directory, `${name}.md`)
}

/** Resolve the file one entry is addressed by at one location. */
function entryFile(location: string, form: SkillEntryForm): string {
  return form === 'bundle' ? join(location, BUNDLE_ENTRY) : location
}

/**
 * Resolve one requested file against an entry's file root.
 * @param entry - the entry whose files are addressed.
 * @param path - forward-slash path relative to the entry's file root.
 * @returns the absolute path to read or write.
 * @throws {RemoteError} `skill-admin/file-escapes-entry` when the path is
 * absolute, empty, or resolves outside the entry's file root.
 */
function entryFilePath(entry: SkillAdminEntry, path: string): string {
  // A flat skill's file root is the directory it shares with every sibling
  // skill, so the only file it owns is the one addressing it.
  if (entry.form === 'flat' && path !== basename(entry.path)) {
    throw new RemoteError('skill-admin/file-escapes-entry', `skill file path ${JSON.stringify(path)} names no file of ${JSON.stringify(entry.name)}`, {
      path,
    })
  }
  if (path === '' || isAbsolute(path)) {
    throw new RemoteError('skill-admin/file-escapes-entry', `skill file path ${JSON.stringify(path)} is not relative`, {
      path,
    })
  }
  const target = resolve(entry.directory, path)
  if (!contains(entry.directory, target)) {
    throw new RemoteError('skill-admin/file-escapes-entry', `skill file path ${JSON.stringify(path)} leaves the entry`, {
      path,
    })
  }
  return target
}

/** One entry-directory walk's result. */
interface FileWalk {
  readonly files: SkillFileNode[]
  readonly truncated: boolean
}

/**
 * List every file below one entry's directory.
 *
 * The walk stops at a member bound and a depth bound rather than following the
 * tree to its end: a skill directory is user-authored, so one symlink loop or
 * one pathologically nested level must not turn rendering a tree into an
 * unbounded scan. Symbolic links are listed as the entries they are and never
 * followed, so a link out of the directory cannot widen the walk.
 * @param directory - absolute directory to walk.
 * @returns relative paths with byte counts, and whether a bound stopped the walk.
 */
async function walkFiles(directory: string): Promise<FileWalk> {
  const files: SkillFileNode[] = []
  let truncated = false
  const queue: Array<{ path: string; depth: number }> = [{ path: directory, depth: 0 }]
  while (queue.length > 0 && !truncated) {
    const next = queue.shift()
    /* v8 ignore next -- the loop condition proves one entry exists. */
    if (next === undefined) break
    let dirents
    try {
      dirents = await readdir(next.path, { withFileTypes: true })
    } catch {
      // An unreadable subdirectory contributes nothing: the entry point's own
      // readability was settled when discovery read the entry.
      continue
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue
      const path = join(next.path, dirent.name)
      if (dirent.isDirectory()) {
        if (next.depth + 1 > FILE_LIST_MAX_DEPTH) {
          truncated = true
          continue
        }
        queue.push({ path, depth: next.depth + 1 })
        continue
      }
      if (!dirent.isFile()) continue
      if (files.length >= FILE_LIST_MAX_ENTRIES) {
        truncated = true
        break
      }
      files.push({ path: relativePath(directory, path), bytes: (await stat(path)).size })
    }
  }
  // Ordered by code unit rather than by locale: these are paths, and a locale
  // collation would file `references/` ahead of `SKILL.md` in a tree that reads
  // the entry point first.
  return { files: files.sort((left, right) => comparePaths(left.path, right.path)), truncated }
}

/** Order two relative paths the way a file browser lists them. */
function comparePaths(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Express one path relative to a directory with the forward slashes the wire carries. */
function relativePath(directory: string, path: string): string {
  return relative(directory, path).split(sep).join('/')
}

/**
 * Project one file's bytes onto the editor's document shape.
 *
 * A file beyond the editable size bound, or one whose bytes are not UTF-8 text,
 * is reported as read-only with its content withheld rather than truncated:
 * handing back a partial body invites a save that would destroy the rest of it.
 * @param entry - the entry the file belongs to.
 * @param path - the forward-slash relative path the reader asked for.
 * @param bytes - the file's complete bytes.
 * @returns the document the editor renders.
 */
function fileDocument(entry: SkillAdminEntry, path: string, bytes: Buffer): SkillFileDocument {
  if (bytes.byteLength > FILE_MAX_BYTES) {
    return { entryId: entry.entryId, path, text: '', editable: false, readOnlyReason: 'too-large' }
  }
  // A NUL byte is the one signal every text encoding agrees on: UTF-8, UTF-16
  // and the legacy single-byte encodings all keep it out of text payloads.
  if (bytes.includes(0)) {
    return { entryId: entry.entryId, path, text: '', editable: false, readOnlyReason: 'binary' }
  }
  return { entryId: entry.entryId, path, text: utf8(bytes), editable: true }
}

/**
 * Project one staged member onto the shape a reader inspects.
 *
 * A preview is inspected, never edited, so a member whose bytes carry no text
 * is reported as such rather than handed back shortened: the whole point of
 * reading a staged file is to judge what will land on disk.
 * @param path - the member's forward-slash relative path.
 * @param bytes - the member's complete bytes.
 * @returns the file a reader can inspect.
 */
function previewFileOf(path: string, bytes: Uint8Array): ImportPreviewFile {
  if (bytes.byteLength > FILE_MAX_BYTES) return { path, text: '', unreadableReason: 'too-large' }
  if (bytes.includes(0)) return { path, text: '', unreadableReason: 'binary' }
  return { path, text: utf8(bytes) }
}

/**
 * Decode one uploaded archive payload.
 * @param data - canonical base64 as the browser encoded it.
 * @returns the archive bytes.
 * @throws {RemoteError} `skill-admin/upload-invalid` for a non-canonical
 * encoding or a payload beyond the upload bound.
 */
function decodeUpload(data: string): Uint8Array {
  const bytes = Buffer.from(data, 'base64')
  // Re-encoding is the portable canonicality check: Buffer tolerates whitespace
  // and truncated tails a browser never produces, and a payload the browser
  // could not have sent is not one this surface admits.
  if (data.length === 0 || bytes.toString('base64') !== data) {
    throw new RemoteError('skill-admin/upload-invalid', 'the uploaded archive is not canonical base64', {
      reason: 'canonical base64 required',
    })
  }
  if (bytes.byteLength > UPLOAD_MAX_BYTES) {
    throw new RemoteError('skill-admin/upload-invalid', 'the uploaded archive exceeds the upload bound', {
      reason: `${bytes.byteLength} bytes exceeds the ${UPLOAD_MAX_BYTES}-byte upload bound`,
    })
  }
  return new Uint8Array(bytes)
}

/**
 * Refuse a rewrite that would leave a skill entry point undiscoverable.
 *
 * Discovery drops a skill whose frontmatter lacks a kebab-case name or a
 * description without telling the author, so a write producing one is refused
 * here instead of silently retiring the skill.
 * @param text - the replacement text of the entry point.
 * @param path - absolute path of the file, for the failure report.
 * @throws {RemoteError} `skill-admin/invalid-frontmatter` when the text carries
 * no usable frontmatter block.
 */
function requireUsableFrontmatter(text: string, path: string): void {
  let block
  try {
    block = parseSkillFrontmatter(text)
  } catch (error: unknown) {
    throw new RemoteError('skill-admin/invalid-frontmatter', `skill file ${path} carries unparsable frontmatter`, {
      path,
      reason: String(error),
    })
  }
  const name = block === undefined ? undefined : stringValue(block.data.name)
  const description = block === undefined ? undefined : stringValue(block.data.description)
  if (name === undefined || description === undefined || !isSkillName(name)) {
    throw new RemoteError('skill-admin/invalid-frontmatter', `skill file ${path} would no longer be discoverable`, {
      path,
      reason: 'frontmatter requires a kebab-case name and a description',
    })
  }
}
