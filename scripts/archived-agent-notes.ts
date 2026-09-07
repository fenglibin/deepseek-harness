/** Pure archive-format and immutable-manifest helpers. */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { AGENT_NOTE_CLASSES } from './agent-note-tree.ts'

/** Versioned fields in the frozen-content manifest. */
export interface ArchiveManifest {
  version: 1
  files: Readonly<Record<string, string>>
}

/** Hash one archived artifact independently of the repository's Git object format. */
function archiveContentHash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the archive manifest and reject fields or hashes outside its closed schema. */
export function parseArchiveManifest(content: string): ArchiveManifest {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value)) throw new Error('expected a JSON object')
  const fields = Object.keys(value).sort()
  if (fields.join(',') !== 'files,version') throw new Error('expected exactly the fields `version` and `files`')
  if (value.version !== 1) throw new Error('unsupported manifest version (expected 1)')
  if (!isRecord(value.files)) throw new Error('`files` must be an object')
  const files: Record<string, string> = {}
  for (const [path, hash] of Object.entries(value.files)) {
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid content hash for ${path}`)
    }
    files[path] = hash
  }
  return { version: 1, files }
}

/** Render the archive manifest with deterministic path ordering. */
export function renderArchiveManifest(files: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({
    version: 1,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  }, null, 2)}\n`
}

/** Whether a manifest entry names a Chinese archive note, the only sealed artifact kind. */
function isChineseNotePath(path: string): boolean {
  return path.endsWith('.zh.md')
}

/**
 * Reject removal of sealed `.zh.md` artifacts across a change. The archive is
 * Chinese-only: historical English `.md` and `.i18n.yaml` entries were retired
 * by the single-language migration and are no longer protected. A `.zh.md`
 * hash may evolve only through an explicit `--write`/`--rewrite` reseal whose
 * manifest diff lands in the same change; silent drift is caught instead by
 * {@link extendArchiveManifest}'s seal-versus-disk consistency check.
 */
export function validateArchiveManifestExtension(
  baseline: ArchiveManifest,
  current: ArchiveManifest,
): string[] {
  const errors: string[] = []
  for (const [path] of Object.entries(baseline.files)) {
    if (!isChineseNotePath(path)) continue
    if (!Object.hasOwn(current.files, path)) errors.push(`${path}: sealed manifest entry is missing`)
  }
  return errors
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Validate the header of one archived Chinese Agent Note. */
function validateHeader(path: string, content: Buffer, sourceBase: string): string[] {
  const errors: string[] = []
  const lines = content.toString('utf8').split('\n')
  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) errors.push(`${path}: line 1 must be \`# Agent Note: <title>\``)
  if (lines[1] !== '') errors.push(`${path}: line 2 must be blank`)
  if (lines[2] !== 'Status: implemented') errors.push(`${path}: line 3 must be \`Status: implemented\``)
  const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[3] ?? '')?.[1]
  if (archived === undefined || !validDate(archived)) {
    errors.push(`${path}: line 4 must be \`Archived: YYYY-MM-DD\` with a valid date`)
  } else if (archived < sourceBase.slice(0, 10)) {
    errors.push(`${path}: archive date ${archived} predates the note filename`)
  }
  if (lines[4] !== '') errors.push(`${path}: line 5 must be blank`)
  return errors
}

/** Validate the closed kind tree, implemented/archive headers, and Chinese archive files. */
export function validateArchiveArtifacts(artifacts: ReadonlyMap<string, Buffer>): string[] {
  const errors: string[] = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    const match = /^([^/]+)\/(\d{4}-\d{2}-\d{2}-.+?)\.zh\.md$/.exec(path)
    if (match?.[1] === undefined || match[2] === undefined) {
      errors.push(`${path}: expected {kind}/yyyy-mm-dd-topic.zh.md`)
      continue
    }
    if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(match[1])) {
      errors.push(`${path}: unknown Agent Note kind ${JSON.stringify(match[1])}`)
      continue
    }
    errors.push(...validateHeader(path, content, basename(match[2])))
  }
  return errors
}

/**
 * Seal the current Chinese archive. The archive is append-only for `.zh.md`
 * artifacts: every current `.zh.md` must already be sealed or be added now,
 * and a sealed `.zh.md` whose content changed outside `--write` is rejected.
 * Historical English `.md` / `.i18n.yaml` entries were retired by the
 * single-language migration; they are dropped rather than checked.
 */
export function extendArchiveManifest(
  existing: ArchiveManifest,
  artifacts: ReadonlyMap<string, Buffer>,
): { files: Record<string, string>; added: string[]; errors: string[] } {
  const errors: string[] = []
  const files: Record<string, string> = {}
  for (const [path, expected] of Object.entries(existing.files)) {
    if (!isChineseNotePath(path)) continue
    const content = artifacts.get(path)
    if (content === undefined) errors.push(`${path}: sealed artifact is missing`)
    else if (archiveContentHash(content) !== expected) errors.push(`${path}: sealed content hash changed`)
    else files[path] = expected
  }
  const added: string[] = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    if (!isChineseNotePath(path)) continue
    if (files[path] !== undefined) continue
    files[path] = archiveContentHash(content)
    added.push(path)
  }
  return { files, added, errors }
}
