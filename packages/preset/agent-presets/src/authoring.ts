/**
 * Copying, reading, and deleting locally authored presets, plus the one
 * in-place edit a listing surface needs.
 *
 * CREATING and DELETING a preset is confined to a `user` root: the shipped
 * `.system` set is part of the deployment, and letting a browser rewrite it
 * would turn "reset to a known preset" into something the same caller could
 * have broken first. EDITING one row's `disabled` is not — it changes one
 * plugin's enablement in a composition the deployment already supplied, and a
 * deployment that ships a preset ships the decision to run it, not a veto over
 * whether this user runs it.
 *
 * No caller supplies composition text: the inputs are ids the host resolves
 * against its own roots plus an optional display name, so authoring grants no
 * capability the copied preset did not already carry. The row edit is
 * addressed the same way — by id, never by text — and rewrites only the one
 * line it owns, because a shipped composition carries its design rationale in
 * comments that a whole-file re-render would delete.
 * @module @deepseek-ai/dsh-agent-presets/authoring
 */

import { chmod, cp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { METADATA_FILE, renderPresetMetadata } from './metadata.ts'
import { PRESET_ID, type AgentPreset, type PresetRoot } from './preset.ts'

/**
 * Refuse one authoring request the deployment does not allow.
 * @param presetId - what the caller tried to change, for the diagnostic.
 * @param reason - why authoring is refused.
 * @returns the failure to throw.
 */
function notWritable(presetId: string, reason: string): RemoteError<'agent-preset/read-only'> {
  return new RemoteError(
    'agent-preset/read-only',
    `agent-presets: preset "${presetId}" cannot be written: ${reason}`,
    { agentPreset: presetId, reason },
  )
}

/**
 * Refuse a copy onto an id something already occupies. Both the roster check
 * and the on-disk check answer with it, so a taken id reads the same either way.
 * @param presetId - the id that is already taken.
 * @returns the failure to throw.
 */
export function presetExists(presetId: string): RemoteError<'agent-preset/invalid'> {
  const reason = `preset "${presetId}" already exists — `
    + 'a copy never overwrites; delete the existing preset first or choose another id'
  return new RemoteError('agent-preset/invalid', `agent-presets: ${reason}`, { agentPreset: presetId, reason })
}

/**
 * The root locally authored presets are written to.
 * @param roots - the configured roots in precedence order.
 * @param presetId - the preset the caller is authoring, named by the refusal.
 * @returns the absolute path of the first `user` root.
 * @throws when the deployment configured no writable root.
 */
export function writableRoot(roots: readonly PresetRoot[], presetId: string): string {
  const root = roots.find(candidate => candidate.trust === 'user')
  if (root === undefined) {
    throw notWritable(presetId, 'this deployment configures no user-writable preset root')
  }
  return resolve(expandHomePath(root.path))
}

/**
 * Read one preset's composition text.
 * @param preset - the resolved preset.
 * @returns the file's contents.
 */
export async function readComposition(preset: AgentPreset): Promise<string> {
  return await readFile(preset.path, 'utf8')
}

/** Whether anything occupies the path (cp's own errorOnExist backstops races). */
async function occupied(path: string): Promise<boolean> {
  let present = true
  try {
    await stat(path)
  } catch {
    // Every stat failure means the same thing here: nothing usable occupies
    // the path, so the copy may claim it.
    present = false
  }
  return present
}

/**
 * Re-tighten a copied tree to owner-only. A shipped preset is world-readable
 * in its install and `cp` preserves that; the copy carries the same weight as
 * the settings document beside it, so group/other access is stripped. A
 * file's owner-execute bit survives — a preset may ship runnable helpers.
 */
async function tightenModes(dir: string): Promise<void> {
  await chmod(dir, 0o700)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name)
    if (entry.isDirectory()) {
      await tightenModes(target)
    } else {
      /* v8 ignore next -- Windows exposes no POSIX owner-execute bit; the POSIX lane covers both file modes. */
      await chmod(target, ((await stat(target)).mode & 0o100) === 0 ? 0o600 : 0o700)
    }
  }
}

/**
 * Create a preset by copying an existing one's whole directory.
 *
 * The copy carries everything the source directory holds — composition,
 * metadata, skill directories, assets — because a preset is its directory,
 * not one file. Symlinks are dereferenced so the copy is self-contained
 * rather than a set of links back into the install it was copied from.
 *
 * The copied metadata is then rewritten: the source's description is kept
 * (the file is the author's to edit afterwards), but its name and roster
 * `order` are not — a copy presenting itself identically to its source, or
 * sorted into the shipped set's declared order, would make the roster stop
 * distinguishing them. With no name given and no description to keep, the
 * file is removed so the copy publishes nothing rather than a blank.
 * @param roots - the configured roots; the first `user` one receives the copy.
 * @param source - the resolved preset the copy starts from.
 * @param id - the new preset's id, which becomes its directory name.
 * @param name - display name for the copy; omitted falls back to the id.
 * @returns the absolute path of the new preset directory.
 * @throws when the id is unusable or already occupied on disk, or the
 * deployment configures no writable root.
 */
export async function copyComposition(
  roots: readonly PresetRoot[],
  source: AgentPreset,
  id: string,
  name?: string,
): Promise<string> {
  if (!PRESET_ID.test(id)) {
    const reason = `preset id ${JSON.stringify(id)} must match ${String(PRESET_ID)} — `
      + 'the id is a directory name, so anything else could escape the preset root'
    throw new RemoteError('agent-preset/invalid', `agent-presets: ${reason}`, { agentPreset: id, reason })
  }
  const dir = join(writableRoot(roots, id), id)
  // The roster check upstream only sees discovered presets; a directory with
  // no composition file still occupies the name and deserves a readable
  // refusal rather than a filesystem error code.
  if (await occupied(dir)) throw presetExists(id)
  try {
    await cp(dirname(source.path), dir, {
      recursive: true, dereference: true, force: false, errorOnExist: true,
    })
    await tightenModes(dir)
    const rendered = renderPresetMetadata({
      ...name === undefined ? {} : { name },
      ...source.description === undefined ? {} : { description: source.description },
    })
    const metadataPath = join(dir, METADATA_FILE)
    if (rendered === undefined) {
      await rm(metadataPath, { force: true })
    } else {
      await writeFileAtomic(metadataPath, rendered, { mode: 0o600, dirMode: 0o700 })
    }
  } catch (error) {
    // A half-copied directory would be invisible to discovery at best and a
    // mountable-but-incomplete preset at worst; a failed copy leaves nothing.
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}

/**
 * Refuse one edit to a composition that cannot carry it.
 * @param presetId - the preset the caller tried to change.
 * @param reason - why the change is refused.
 * @returns the failure to throw.
 */
function invalidComposition(presetId: string, reason: string): RemoteError<'agent-preset/invalid'> {
  return new RemoteError(
    'agent-preset/invalid',
    `agent-presets: preset "${presetId}" cannot be changed: ${reason}`,
    { agentPreset: presetId, reason },
  )
}

/**
 * The directory a whole-preset write is confined to.
 *
 * Both guards answer with the same readable refusal: a shipped preset is the
 * deployment's, and a preset discovered from a later root is outside what the
 * writable root owns — deleting a directory this root does not own is the
 * failure both exist to avoid.
 * @param roots - the configured roots.
 * @param preset - the resolved preset a write is aimed at.
 * @returns the absolute path of the preset's directory under the writable root.
 * @throws when the preset ships with the deployment or lies outside that root.
 */
function containedPreset(roots: readonly PresetRoot[], preset: AgentPreset): string {
  if (preset.trust !== 'user') {
    throw notWritable(preset.id, 'it ships with the deployment')
  }
  const dir = join(writableRoot(roots, preset.id), preset.id)
  // Belt and braces over the id pattern: the resolved directory must still be
  // the one the writable root owns, whatever discovery reported.
  if (!isAbsolute(preset.path) || !preset.path.startsWith(dir)) {
    throw notWritable(preset.id, 'it does not live under the writable preset root')
  }
  return dir
}

/**
 * Delete a locally authored preset.
 *
 * A shipped preset is refused: it belongs to the deployment. A preset a live
 * session mounted is NOT refused — the composition was read at creation and is
 * never re-read, so that session keeps running exactly as it was.
 * @param roots - the configured roots.
 * @param preset - the resolved preset to remove.
 * @throws when the preset ships with the deployment or lies outside the writable root.
 */
export async function deleteComposition(
  roots: readonly PresetRoot[],
  preset: AgentPreset,
): Promise<void> {
  const dir = containedPreset(roots, preset)
  await rm(dir, { recursive: true, force: true })
}

/** One parsed composition row, as the Loader's own dialect yields it. */
type CompositionRow = Record<string, unknown>

/**
 * Find one row by id inside a composition, descending into group rows the way
 * the Loader flattens them for a listing.
 * @param rows - a parsed row list, or a group's nested one.
 * @param entryId - the id the row declares.
 * @returns the row, or undefined when no row declares that id.
 */
function findRow(rows: readonly unknown[], entryId: string): CompositionRow | undefined {
  for (const value of rows) {
    if (typeof value !== 'object' || value === null) continue
    const row = value as CompositionRow
    if (row.id === entryId) return row
    if (row.group === true && Array.isArray(row.config)) {
      const nested = findRow(row.config, entryId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** One list item's extent in a composition file, as its author wrote it. */
interface RowBlock {
  /** Index of the line carrying the item's `- ` marker. */
  readonly start: number
  /** Index one past the item's last line. */
  readonly end: number
  /** Column the item's own keys start at. */
  readonly keyIndent: number
}

/** A line that opens one list item, capturing its indentation. */
const ITEM_START = /^(\s*)-\s+/

/** The `disabled` key of one row, at one exact indentation. */
function disabledAt(line: string, keyIndent: number): boolean {
  const match = /^(\s*)disabled:/.exec(line)
  return match !== null && (match[1] ?? '').length === keyIndent
}

/**
 * Locate the list item declaring one id, without assuming where it sits.
 *
 * Every `- ` line opens a candidate whose extent ends at the next line no
 * longer indented past its marker — a blank or comment line never ends it, so
 * the comment blocks a shipped composition puts between rows stay outside the
 * item while a nested `config:` row stays inside its group. The candidate is
 * parsed on its own to read its `id`, so a row whose first key is not `id`,
 * and one nested under a group, are found the same way a top-level row is.
 * @param lines - the composition file's lines.
 * @param entryId - the id the wanted row declares.
 * @returns the item's extent, or undefined when no item declares that id.
 */
function rowBlock(lines: readonly string[], entryId: string): RowBlock | undefined {
  for (let start = 0; start < lines.length; start++) {
    const marker = ITEM_START.exec(lines[start] ?? '')
    if (marker === null) continue
    const indent = (marker[1] ?? '').length
    let end = lines.length
    for (let index = start + 1; index < lines.length; index++) {
      const line = lines[index] ?? ''
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      if (line.length - line.trimStart().length <= indent) {
        end = index
        break
      }
    }
    const parsed: unknown = load(lines.slice(start, end).join('\n'), { schema: entryListSchema })
    if (!Array.isArray(parsed)) continue
    if ((parsed[0] as { id?: unknown } | undefined)?.id !== entryId) continue
    const next = lines.slice(start + 1, end).find(line => line.trim() !== '' && !line.trim().startsWith('#'))
    const keyIndent = next === undefined ? indent + 2 : next.length - next.trimStart().length
    return { start, end, keyIndent }
  }
  return undefined
}

/**
 * Enable or disable one plugin row of one preset's composition.
 *
 * The row is addressed by the id its own composition file declares, so an
 * unnamed row cannot be changed — a listing shows those without an identity to
 * write to. Enabling deletes `disabled` rather than writing `false`, because
 * "no gate" and "explicitly not disabled" are one state and only the former
 * reads the way the rest of the file does. A row gated by a `!!js` expression
 * is left alone: replacing it is the author's call, not a switch's.
 *
 * Only the one `disabled` line moves. A whole-file re-render through `dump`
 * would cost a shipped composition every comment in it, and those comments are
 * where the deployment records why each row is there. The edited text is read
 * back before it is written, so a layout this edit misread fails here instead
 * of leaving a composition the Loader can no longer parse.
 *
 * A shipped preset is written in place, at the path discovery resolved; only
 * creating and deleting a preset stay confined to a `user` root.
 * @param preset - the resolved preset whose composition to change.
 * @param entryId - the id the target row declares.
 * @param disabled - whether the row should be stopped.
 * @throws when the composition cannot be read or parsed, no row declares that
 * id, that row carries a `!!js` gate, or the row is written in a flow style
 * this edit cannot preserve.
 */
export async function writeRowDisabled(
  preset: AgentPreset,
  entryId: string,
  disabled: boolean,
): Promise<void> {
  let raw: string
  try {
    raw = await readFile(preset.path, 'utf8')
  } catch (error) {
    throw invalidComposition(preset.id, `composition file is unreadable: ${String(error)}`)
  }
  const parsed: unknown = load(raw, { schema: entryListSchema })
  if (!Array.isArray(parsed)) {
    const reason = 'composition file is not a row list'
    throw invalidComposition(preset.id, reason)
  }
  const row = findRow(parsed, entryId)
  if (row === undefined) {
    throw invalidComposition(preset.id, `no row declares id ${JSON.stringify(entryId)}`)
  }
  if (isJsExpr(row.disabled)) {
    const reason = `row ${JSON.stringify(entryId)} is gated by a !!js expression, which only its author may replace`
    throw invalidComposition(preset.id, reason)
  }

  const lines = raw.split('\n')
  const block = rowBlock(lines, entryId)
  if (block === undefined) {
    const reason = `row ${JSON.stringify(entryId)} is written in a form this edit cannot preserve`
    throw invalidComposition(preset.id, reason)
  }
  const keyLine = lines
    .slice(block.start + 1, block.end)
    .findIndex(line => disabledAt(line, block.keyIndent))
  const flag = `${' '.repeat(block.keyIndent)}disabled: true`
  const edited = block.start + 1 + keyLine
  if (disabled) {
    if (keyLine === -1) lines.splice(block.start + 1, 0, flag)
    else lines[edited] = flag
  } else if (keyLine !== -1) {
    lines.splice(edited, 1)
  }

  const text = lines.join('\n')
  const reason = `row ${JSON.stringify(entryId)} is written in a form this edit cannot preserve`
  let reread: unknown
  try {
    reread = load(text, { schema: entryListSchema })
  } catch {
    // A flow-style row is the shape that lands here: appending a key line to
    // `- {id: …}` is not YAML, and guessing at its layout is worse than
    // leaving the row for its author to retype.
    throw invalidComposition(preset.id, reason)
  }
  if (!Array.isArray(reread) || findRow(reread, entryId)?.disabled !== (disabled || undefined)) {
    throw invalidComposition(preset.id, reason)
  }
  // A locally authored preset is the user's document and is written owner-only
  // like the settings file beside it. A deployment-owned one is written back
  // with the mode it already had: tightening it to owner-only can lock a host
  // running as another user out of the composition it boots from.
  const mode = preset.trust === 'user' ? 0o600 : (await stat(preset.path)).mode & 0o777
  await writeFileAtomic(preset.path, text, { mode, dirMode: 0o700 })
}
