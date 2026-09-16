/**
 * What the file browser was asked to show. Its own module because both the
 * dialog (a consumer) and `index.ts` (the registrant that publishes requests)
 * need the type, and the dialog must not import the registrant's module.
 * @module @deepseek-ai/dsh-client-ui-file-browser/request
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

/**
 * One open request. The discriminant is the intent, not a flag: browsing a
 * Workspace starts at its tree, opening a file starts at that file and is
 * read-only, and a request that could not be served states why.
 *
 * `unavailable` is a request arm rather than a returned error so the viewer
 * owns the only report a caller can produce: a session whose Workspace cannot
 * be resolved is a fact to show, never a reason to fall back to the Host
 * desktop opener.
 */
export type FileBrowserRequest =
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId; readonly title: string }
  | {
    readonly kind: 'file'
    readonly workspaceId: WorkspaceId
    /** Workspace-relative path the dialog opens directly. */
    readonly path: string
    readonly title: string
    readonly readOnly: true
  }
  | {
    readonly kind: 'unavailable'
    /** The path the caller asked for, shown so the operator knows what failed. */
    readonly path: string
    readonly reason: 'no-workspace'
  }

/**
 * Whether a request presents a single file rather than the tree. A file view
 * and a refused file view share this layout: neither has a tree to show.
 * @param request - the current request, or undefined while closed.
 * @returns true when the dialog renders the single-pane file layout.
 */
export function isFileRequest(request: FileBrowserRequest | undefined): boolean {
  return request?.kind === 'file' || request?.kind === 'unavailable'
}
