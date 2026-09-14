/**
 * Canonical spelling of one mutation path. The fold's key and the browser's
 * key must be the same string, so this module is the one implementation both
 * sides call.
 *
 * @module @deepseek-ai/dsh-file-changes/path
 */

import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'

/**
 * Canonical spelling of one mutation path: resolved against the Session
 * Workspace root, with both separators unified to `/` and empty, `.`, and
 * `..` segments collapsed. A Windows drive prefix survives verbatim.
 *
 * Two calls naming the same file with different spellings — once absolute,
 * once Workspace-relative — yield one key, which is what keeps a file from
 * being listed twice.
 * @param path - path exactly as the tool call spelled it.
 * @param cwd - Session Workspace root; absent leaves a relative path relative.
 * @returns the canonical path.
 */
export function canonicalMutationPath(path: string, cwd: string | undefined): string {
  const resolved = resolveWorkspacePath(cwd, path)
  const kept: string[] = []
  for (const segment of resolved.split(/[/\\]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && kept.length > 0 && kept[kept.length - 1] !== '..') {
      kept.pop()
      continue
    }
    kept.push(segment)
  }
  return (resolved.startsWith('/') ? '/' : '') + kept.join('/')
}
