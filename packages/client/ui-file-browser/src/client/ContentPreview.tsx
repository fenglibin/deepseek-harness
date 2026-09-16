/**
 * The content pane's preview: the rendered form of a buffer whose extension
 * names a preview kind.
 *
 * The two arms are deliberately different mechanisms. Markdown goes through
 * this repository's one Markdown pipeline (`MarkdownText`), which is what gives
 * a previewed document the same tables, task lists, TeX and Mermaid diagrams
 * the conversation and the plugin READMEs already render. HTML cannot: the file
 * *is* a document, so it is handed to the browser's own parser through an
 * inline frame, and the frame is sandboxed to an opaque origin so a previewed
 * page can run its own scripts without reaching the host page's storage,
 * cookies, or same-origin endpoints.
 *
 * Nothing here reads from disk: both arms render the buffer the caller already
 * holds, so unsaved edits preview exactly as they would be written.
 * @module @deepseek-ai/dsh-client-ui-file-browser/ContentPreview
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownDiagrams, MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PreviewKind } from './preview.ts'
import css from './ContentPreview.module.css'

/** Localized chrome of one preview, as flat strings the caller already holds. */
export interface ContentPreviewLabels {
  /** Accessible name of the inline frame rendering an HTML document. */
  readonly frame: string
  /** Markdown fence copy control. */
  readonly copy: string
  /** Markdown fence copy control, after a successful copy. */
  readonly copied: string
  /** Markdown footnote section heading. */
  readonly footnotes: string
  /** Prefix shown with a diagram that failed to render. */
  readonly diagramError: string
}

/** Props of {@link ContentPreview}. */
export interface ContentPreviewProps {
  /** Which rendering this buffer gets. */
  readonly kind: PreviewKind
  /** The buffer to render — the current editor content, saved or not. */
  readonly text: string
  /** Localized chrome. */
  readonly labels: ContentPreviewLabels
}

/**
 * Render one buffer as its preview.
 * @param props - see {@link ContentPreviewProps}.
 * @returns the preview element for the buffer's kind.
 */
export function ContentPreview({ kind, text, labels }: ContentPreviewProps): ReactNode {
  // The Markdown renderer treats a new `labels` or `diagrams` identity as new
  // chrome and discards its cached render, so both are derived from the flat
  // strings rather than rebuilt per render.
  const markdown = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: labels.copy, copiedLabel: labels.copied },
    footnotes: labels.footnotes,
  }), [labels.copy, labels.copied, labels.footnotes])
  const diagrams = useMemo<MarkdownDiagrams>(() => ({ errorLabel: labels.diagramError }), [labels.diagramError])

  if (kind === 'html') {
    return (
      // `allow-scripts` without `allow-same-origin`: the document runs its own
      // code from an opaque origin, so it can draw itself while `localStorage`,
      // cookies, and fetches against this page's origin all fail.
      <iframe
        className={css.frame}
        title={labels.frame}
        sandbox="allow-scripts"
        srcDoc={text}
      />
    )
  }
  return (
    <div className={css.markdown}>
      <MarkdownText text={text} labels={markdown} diagrams={diagrams} />
    </div>
  )
}
