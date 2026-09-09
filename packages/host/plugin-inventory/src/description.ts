/**
 * Plugin descriptions read from the README of the package that ships a module.
 *
 * The Loader names a plugin only by module specifier, and neither Cordis nor
 * the Loader carries prose about it; what does is the package's own README,
 * whose frontmatter `description` is the one sentence a listing surface can
 * show and whose body is the document a viewer opens. Every failure here
 * degrades to absence rather than to an error: a vendored `cordis:` builtin,
 * a specifier no anchor resolves, a package publishing no README, and a README
 * with no frontmatter all mean "this plugin published nothing".
 * @module @deepseek-ai/dsh-host-plugin-inventory/description
 */

import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'

/** README filenames, most specific language first. */
const README_NAMES = ['README.zh.md', 'README.md'] as const

/** The fence delimiting a README's leading YAML frontmatter block. */
const FRONTMATTER_FENCE = '---'

/** Whether one path can be read at all, without reporting why not. */
async function readable(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // Every access failure means the same thing to a walk: this path offers
    // nothing, so keep looking elsewhere.
    return false
  }
}

/** One README an owning package ships: the name it was found under and its whole text. */
export interface PluginReadme {
  /** `README.zh.md` or `README.md`, whichever the package ships. */
  readonly name: string
  /** The file's text, verbatim. */
  readonly text: string
}

/**
 * Read the nearest README above one resolved module file.
 *
 * The walk stops at the owning package's manifest because a README further up
 * belongs to a different package — in this repository, to a package group.
 * @param moduleFile - absolute path of the resolved module.
 * @returns the README and the name it was found under, or undefined when no
 * owning package ships one.
 */
async function nearestReadme(moduleFile: string): Promise<PluginReadme | undefined> {
  let current = dirname(moduleFile)
  while (true) {
    for (const name of README_NAMES) {
      try {
        return { name, text: await readFile(join(current, name), 'utf8') }
      } catch {
        // Absent or unreadable: try the next filename at this level.
      }
    }
    if (await readable(join(current, 'package.json'))) return undefined
    const parent = dirname(current)
    // The filesystem root is its own parent; stopping there ends the walk for
    // a module no manifest owns instead of spinning on it.
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Resolve one module specifier to a file the anchors reach.
 * @param moduleName - exact module specifier a Loader entry or composition row names.
 * @param anchors - base URLs the specifier may resolve from, in precedence order.
 * @returns the resolved module file, or undefined when no anchor installs it.
 */
function resolveModule(moduleName: string, anchors: readonly string[]): string | undefined {
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(moduleName)
    } catch {
      // Nothing installed under this anchor: try the next one.
    }
  }
  return undefined
}

/**
 * The YAML text of one README's leading frontmatter block.
 * @param text - the whole README.
 * @returns the block between the opening and closing fence, or undefined when
 * the file opens with no complete block.
 */
function frontmatterBlock(text: string): string | undefined {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return undefined
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE)
  return end === -1 ? undefined : lines.slice(1, end).join('\n')
}

/**
 * The `description` one README published.
 * @param text - the whole README.
 * @returns the trimmed description, or undefined when the README published none.
 */
function frontmatterDescription(text: string): string | undefined {
  const block = frontmatterBlock(text)
  if (block === undefined) return undefined
  let parsed: unknown
  try {
    parsed = load(block)
  } catch {
    // Malformed frontmatter is not worth failing a listing over.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { description } = parsed as { description?: unknown }
  if (typeof description !== 'string') return undefined
  const trimmed = description.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The README body one package published, with its frontmatter block removed.
 *
 * The block is a document-authoring header, not content: a viewer that kept it
 * would open every README with a bare `---`-fenced list of keys.
 * @param text - the whole README.
 * @returns the body, or the whole text when it carries no complete block.
 */
export function readmeBody(text: string): string {
  const block = frontmatterBlock(text)
  if (block === undefined) return text
  const lines = text.split('\n')
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE)
  return lines.slice(end + 1).join('\n').replace(/^\s*\n/, '')
}

/**
 * Read the README one plugin module's package ships, frontmatter included.
 * @param moduleName - exact module specifier a Loader entry or composition row names.
 * @param anchors - base URLs the specifier may resolve from, in precedence order.
 * @returns the README under the name it was found under, or undefined when the
 * module cannot be resolved or its package ships none.
 */
export async function pluginReadme(
  moduleName: string,
  anchors: readonly string[],
): Promise<PluginReadme | undefined> {
  // Builtins are Loader-internal and ship inside Cordis, which publishes no
  // per-plugin README; resolving one would only burn the anchor loop.
  if (moduleName.startsWith('cordis:')) return undefined
  const resolved = resolveModule(moduleName, anchors)
  return resolved === undefined ? undefined : await nearestReadme(resolved)
}

/**
 * Resolve the description one plugin module published.
 *
 * Anchors are tried in order because a bare package name resolves only from a
 * directory whose `node_modules` carries it: a harness package's own directory
 * holds its dependencies alone, so the composition's base — not this
 * package's — is what reaches the deployment's full set. The first anchor that
 * resolves the specifier decides, including when it resolves to a package
 * publishing no description.
 * @param moduleName - exact module specifier a Loader entry or composition row names.
 * @param anchors - base URLs the specifier may resolve from, in precedence order.
 * @returns the description, or undefined when the module published none.
 */
export async function pluginDescription(
  moduleName: string,
  anchors: readonly string[],
): Promise<string | undefined> {
  const readme = await pluginReadme(moduleName, anchors)
  return readme === undefined ? undefined : frontmatterDescription(readme.text)
}
