/**
 * Containment for session-revision paths: a revert writes to disk, so every
 * path it is handed must resolve inside the session's workspace root before it
 * is touched.
 *
 * This is the same trust question the file browser answers for its own writes,
 * and it is answered here rather than by trusting the recorded path because a
 * recorded path is data from the session log — a symlink placed after capture
 * could otherwise point a revert at a file outside the workspace.
 * @module @deepseek-ai/dsh-api-session-file-revisions/containment
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

/**
 * Resolve one path to its canonical form, refusing anything that leaves the
 * root. A symlink is followed, so a link inside the workspace that points
 * outside is refused too.
 * @param root - absolute workspace root.
 * @param path - absolute path to check.
 * @returns the canonical absolute path.
 * @throws {EscapeError} when the path resolves outside the root.
 */
export async function containPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  const canonical = await canonicalOf(path)
  if (!isUnder(canonicalRoot, canonical)) throw new EscapeError(path)
  return canonical
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
 * Canonicalize a path, tolerating the parts that do not exist yet.
 *
 * A revert may target a path whose file was removed since capture, so the deep
 * ancestor is canonicalized and the missing tail is re-appended verbatim.
 * @param path - absolute path, existing or not.
 * @returns its canonical form.
 */
async function canonicalOf(path: string): Promise<string> {
  const target = isAbsolute(path) ? normalize(path) : resolve(path)
  const segments = target.split(sep).filter(segment => segment !== '')
  let current: string = sep
  const missing: string[] = []
  while (segments.length > 0) {
    const head = segments[0] as string
    const next = current === sep ? sep + head : `${current}${sep}${head}`
    try {
      current = await realpath(next)
      segments.shift()
    } catch {
      missing.unshift(head)
      segments.shift()
      if (segments.length === 0) break
    }
  }
  return missing.length === 0 ? current : `${current}${sep}${missing.join(sep)}`
}

/**
 * Whether one canonical path is the root or lies beneath it.
 * @param root - canonical root.
 * @param path - canonical path to test.
 * @returns true when the path is inside the root.
 */
function isUnder(root: string, path: string): boolean {
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.startsWith(prefix)
}
