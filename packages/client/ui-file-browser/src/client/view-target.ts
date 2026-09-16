/**
 * Resolving a session's file link to the Workspace that scopes it.
 *
 * A session belongs to exactly one Workspace — the registry groups sessions by
 * their cwd path and every Workspace row carries the `sessionIds` it accounts
 * for — so the lookup is a read of the Client's existing Workspace snapshot
 * rather than a Host round trip.
 * @module @deepseek-ai/dsh-client-ui-file-browser/view-target
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'

/**
 * Find the Workspace a session is accounted to.
 * @param workspaces - the Client Workspace Controller.
 * @param sessionId - session whose file link was followed.
 * @returns the owning Workspace, or undefined when none accounts for it.
 */
export function workspaceOfSession(workspaces: IWorkspaces, sessionId: SessionId): WorkspaceView | undefined {
  const id = String(sessionId)
  return workspaces.list.getSnapshot().items
    .find(workspace => workspace.sessionIds.some(candidate => String(candidate) === id))
}

/**
 * Normalize a path a session reported into the workspace-relative spelling the
 * file browser addresses. A relative path is taken as already root-relative; an
 * absolute path is rebased only when it really lies under the root. Anything
 * else is returned unchanged, because the Host owns containment and a
 * Client-side rewrite of an outside path would either mask the refusal it is
 * about to report or, worse, relocate the read onto a different file.
 * @param workspace - Workspace backing the session.
 * @param path - the path as the session displayed it.
 * @returns the workspace-relative path, or the original when it lies outside.
 */
export function resolveViewPath(workspace: WorkspaceView, path: string): string {
  if (!isAbsoluteHostPath(path)) return path.replace(/^[/\\]+/, '')
  const root = workspace.path.replace(/[/\\]+$/, '')
  if (path.replace(/[/\\]+$/, '') === root) return ''
  if (!path.startsWith(`${root}/`)) return path
  return path.slice(root.length + 1)
}

/** Whether a path is spelled absolutely on any Host platform. */
function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
}
