/**
 * Preview kinds for the file browser's content pane.
 *
 * A preview kind is decided by the file extension alone, the same way the
 * syntax-highlighting hint is: both are presentation facts, and the Host
 * answers file bytes rather than how they should be drawn. An extension that
 * maps to no kind is not previewable at all — the pane renders no preview
 * control for it — which is why this returns `undefined` rather than a
 * "plain text" arm.
 * @module @deepseek-ai/dsh-client-ui-file-browser/preview
 */

/** How the content pane renders a file instead of its source text. */
export type PreviewKind = 'markdown' | 'html'

/** Extension (lowercased, without the dot) to the preview kind it selects. */
const PREVIEW_BY_EXTENSION: Readonly<Record<string, PreviewKind>> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
}

/**
 * Derive the preview kind from a file path's extension.
 *
 * Case-insensitive, and an own-property check so a name like `foo.constructor`
 * maps to no kind rather than to an inherited member. A dotfile whose name
 * begins with the dot (`.gitignore`) carries no extension and yields
 * `undefined`, matching {@link languageOfPath}.
 * @param path - workspace-relative or absolute file path.
 * @returns the preview kind, or `undefined` when the file is not previewable.
 */
export function previewKindOfPath(path: string): PreviewKind | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const extension = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(PREVIEW_BY_EXTENSION, extension) ? PREVIEW_BY_EXTENSION[extension] : undefined
}
