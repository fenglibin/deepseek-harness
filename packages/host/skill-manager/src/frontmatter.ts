/**
 * Skill frontmatter parsing and comment-preserving local edits.
 *
 * Discovery accepts a `---` block on the first line holding the canonical
 * kebab-case keys. This module reads that same shape and rewrites single keys
 * in place, so an edit keeps the comments, key order, and untouched keys the
 * file's author wrote.
 * @module @deepseek-ai/dsh-host-skill-manager/frontmatter
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** One skill file split into its frontmatter block and markdown body. */
export interface SkillFrontmatterBlock {
  /** Parsed frontmatter mapping. */
  readonly data: Record<string, unknown>
  /** Markdown body starting after the closing delimiter's newline. */
  readonly body: string
  /** Offset of the first frontmatter key line. */
  readonly keysStart: number
  /** Offset of the line holding the closing delimiter. */
  readonly keysEnd: number
}

/**
 * Split a skill file into its frontmatter block and body.
 * @param raw - complete file text.
 * @returns the parsed block, or undefined when the file carries no frontmatter block.
 * @throws when a frontmatter block is present but its YAML is invalid.
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatterBlock | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const keysStart = firstLineEnd + 1
  let lineStart = keysStart
  for (;;) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const parsed = parseYaml(raw.slice(keysStart, lineStart)) as unknown
      const body = raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1)
      // An empty block is an empty mapping rather than an absent one: discovery
      // still drops such a file for want of name and description, while this
      // surface can repair it in place instead of only offering deletion.
      const data = parsed === null || parsed === undefined ? {} : parsed
      if (typeof data !== 'object' || Array.isArray(data)) return undefined
      return { data: data as Record<string, unknown>, body, keysStart, keysEnd: lineStart }
    }
    // A last line with no closing delimiter ends the search: there is no block.
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/**
 * Render a complete skill file from explicit frontmatter fields and a body.
 * @param fields - frontmatter entries to write, in the order given.
 * @param content - markdown body; surrounding blank space is trimmed away.
 * @returns the complete file text, newline-terminated.
 */
export function renderSkillDocument(
  fields: readonly (readonly [string, string | boolean])[],
  content: string,
): string {
  const lines = fields.map(([key, value]) => `${key}: ${serializeScalar(value)}`)
  const body = content.trim()
  return `---\n${lines.join('\n')}\n---\n${body.length === 0 ? '' : `\n${body}\n`}`
}

/**
 * Rewrite named top-level frontmatter keys in place, keeping every comment,
 * key order, and key the caller does not name.
 * @param raw - complete file text carrying a frontmatter block.
 * @param updates - key/value pairs to set, applied in order.
 * @returns the rewritten file text.
 * @throws when the file carries no frontmatter block to edit.
 */
export function editSkillFrontmatter(
  raw: string,
  updates: readonly (readonly [string, string | boolean])[],
): string {
  const block = parseSkillFrontmatter(raw)
  if (block === undefined) throw new Error('skill file has no frontmatter block to edit')
  // The slice reaches the closing delimiter's own newline, so its final
  // element is the empty remainder of that boundary rather than a key line.
  const lines = keyLines(raw, block)
  for (const [key, value] of updates) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`)
    const index = lines.findIndex(line => pattern.test(line))
    const rendered = `${key}: ${serializeScalar(value)}`
    if (index >= 0) lines[index] = rendered
    else lines.push(rendered)
  }
  const blockText = lines.length === 0 ? '' : `${lines.join('\n')}\n`
  return `${raw.slice(0, block.keysStart)}${blockText}${raw.slice(block.keysEnd)}`
}

/**
 * Remove named top-level frontmatter keys in place.
 * @param raw - complete file text carrying a frontmatter block.
 * @param keys - top-level keys to drop; absent keys are left alone.
 * @returns the rewritten file text.
 * @throws when the file carries no frontmatter block to edit.
 */
export function removeSkillFrontmatterKeys(raw: string, keys: readonly string[]): string {
  const block = parseSkillFrontmatter(raw)
  if (block === undefined) throw new Error('skill file has no frontmatter block to edit')
  const patterns = keys.map(key => new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`))
  const kept = keyLines(raw, block).filter(line => !patterns.some(pattern => pattern.test(line)))
  const blockText = kept.length === 0 ? '' : `${kept.join('\n')}\n`
  return `${raw.slice(0, block.keysStart)}${blockText}${raw.slice(block.keysEnd)}`
}

/**
 * The key lines of one frontmatter block, with the trailing empty element the
 * slice always carries past the closing delimiter's own newline removed.
 * @param raw - complete file text.
 * @param block - the parsed block to slice.
 * @returns one line per key, in file order.
 */
function keyLines(raw: string, block: SkillFrontmatterBlock): string[] {
  const lines = raw.slice(block.keysStart, block.keysEnd).split('\n')
  return lines.filter((line, index) => line !== '' || index < lines.length - 1)
}

/** Render one YAML scalar for a single-line frontmatter value. */
function serializeScalar(value: string | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return stringifyYaml(value).replace(/\n+$/, '')
}

/** Escape a literal string for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
