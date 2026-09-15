/**
 * Workspace containment: resolve one caller-supplied path against a workspace
 * root and prove the result stays inside it.
 *
 * The check is canonicalize-then-contain, not a lexical prefix test: a symlink
 * inside the workspace can point outside it, and a lexical comparison would
 * follow it happily. `realpath` resolves the deepest existing ancestor, so a
 * link is resolved before the containment decision rather than after it.
 * @module @deepseek-ai/dsh-api-file-browser/containment
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

/**
 * Whether `candidate` is `root` itself or a descendant of it. Both paths must
 * already be canonical; this is the comparison the callers below perform after
 * resolving, never the whole decision.
 * @param root - canonical workspace root.
 * @param candidate - canonical path to test.
 * @returns true when the candidate is contained.
 */
export function isPathUnder(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Join a workspace-relative path onto its root, rejecting anything that would
 * climb out lexically. This is the cheap first half of containment; the
 * `realpath` check against the result is the half that also stops symlinks.
 *
 * `relativePath` arrives from the browser, so it is validated here rather than
 * trusted: an absolute value, or one whose normalized form starts with `..`,
 * names something outside the root by construction.
 * @param root - absolute workspace root.
 * @param relativePath - workspace-root-relative path using `/` separators; empty means the root.
 * @returns the joined absolute path.
 * @throws {Error} when the relative path escapes the root lexically.
 */
export function joinWorkspacePath(root: string, relativePath: string | undefined): string {
  const trimmed = (relativePath ?? '').trim()
  if (trimmed === '') return root
  const normalized = normalize(trimmed).replaceAll('\\', '/')
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new LexicalEscapeError(trimmed)
  }
  return join(root, normalized)
}

/** A workspace-relative path that escapes its root before any filesystem call. */
export class LexicalEscapeError extends Error {
  override readonly name = 'LexicalEscapeError'
  /** @param path - the offending relative path. */
  constructor(readonly path: string) {
    super(`path ${JSON.stringify(path)} leaves the workspace root`)
  }
}

/**
 * Canonicalize `path` and require it to stay under `root`.
 *
 * A target that does not exist yet (a create) cannot be canonicalized directly,
 * so the deepest existing ancestor is resolved and the unresolved remainder is
 * re-joined onto it — that ancestor is where the create would land, and it is
 * what must be contained.
 * @param root - canonical workspace root.
 * @param path - absolute path to resolve and check.
 * @returns the canonical contained path.
 * @throws {EscapeError} when the canonical result leaves the root.
 */
export async function containPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  const resolved = await resolveExistingAncestor(path)
  if (!isPathUnder(canonicalRoot, resolved.canonical)) throw new EscapeError(path)
  return resolved.canonical
}

/** A path whose canonical form leaves the workspace root. */
export class EscapeError extends Error {
  override readonly name = 'EscapeError'
  /** @param path - the path that resolved outside. */
  constructor(readonly path: string) {
    super(`path ${JSON.stringify(path)} resolves outside the workspace root`)
  }
}

/**
 * Resolve the canonical form of the deepest existing ancestor of `path` and
 * re-append the part that does not exist yet.
 * @param path - absolute path, existing or not.
 * @returns the canonical path it would have.
 */
async function resolveExistingAncestor(path: string): Promise<{ canonical: string }> {
  const normalized = normalize(path)
  let current = normalized
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      return { canonical: missing.length === 0 ? canonical : join(canonical, ...missing) }
    } catch {
      const parent = normalize(join(current, '..'))
      // Walking up past the filesystem root cannot happen on a real system, but
      // a malformed path must not spin here: the un-resolvable name is returned
      // as-is and the containment check then refuses it.
      if (parent === current) return { canonical: normalized }
      missing.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      current = parent
    }
  }
}
