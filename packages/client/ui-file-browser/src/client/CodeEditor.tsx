/**
 * The text editor: a read-only shiki highlight layer with a transparent
 * textarea stacked exactly on top of it.
 *
 * The lower `<pre>` owns appearance (one colored span per token) and the upper
 * `<textarea>` owns editing, the caret, and selection; the textarea's text is
 * transparent so the colored layer shows through. Both layers use the same
 * font, line height, and padding, which is what keeps the caret on the glyph
 * the operator sees.
 *
 * Highlighting is re-derived from the current buffer rather than only from the
 * saved file, so the coloring follows what is being typed. Tokenizing a whole
 * document per keystroke would be wasteful, so it is deferred by a short timer
 * and skipped entirely while a lazy grammar is still loading (the layer then
 * renders plain text and re-colors when the grammar arrives).
 *
 * A file whose extension names a preview kind carries one extra control: a
 * preview switch that swaps the editor for the rendered document. The two views
 * share the one buffer, so previewing never discards unsaved work — it shows
 * that work rendered, and switching back returns to it unchanged.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button, grammarLoadCount, highlightLines, subscribeGrammarLoaded,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import { languageOfPath } from './language.ts'
import { previewKindOfPath } from './preview.ts'
import { ContentPreview } from './ContentPreview.tsx'
import css from './CodeEditor.module.css'

/** How long typing may settle before the highlight layer re-tokenizes. */
const RETOKENIZE_DELAY_MS = 120

/** The editor's localized chrome, supplied by the owning dialog. */
export interface CodeEditorLabels {
  save: string
  saving: string
  saved: string
  unsaved: string
  reload: string
  saveFailed: string
  conflict: string
  overwrite: string
  readonly: string
  loading: string
  /** Label of the preview switch shown for a previewable file. */
  preview: string
  /** Accessible name of the inline HTML preview frame. */
  previewFrame: string
  /** Markdown fence copy control. */
  copy: string
  /** Markdown fence copy control, after a successful copy. */
  copied: string
  /** Markdown footnote section heading. */
  footnotes: string
  /** Prefix shown with a diagram that failed to render. */
  diagramError: string
}

/** Props of {@link CodeEditor}. */
export interface CodeEditorProps {
  /** Workspace-relative path of the file being edited (drives the language hint). */
  path: string
  /** Content on disk when the file was opened; the baseline for the unsaved check. */
  savedText: string
  /** Current buffer. */
  text: string
  /** Report one buffer change. */
  onChange: (text: string) => void
  /** Save the buffer; resolves once the write settled (a rejection reports failure). */
  onSave: () => Promise<void>
  /** Discard the buffer and re-read the file from disk. */
  onReload: () => void
  /** A write is in flight. */
  saving: boolean
  /** The last write failed on a version mismatch. */
  conflict: boolean
  /** Overwrite despite the mismatch. */
  onOverwrite: () => void
  /** A read is in flight (the pane shows its loading state). */
  loading: boolean
  /** The file cannot be written (binary or over the bound). */
  readOnly: boolean
  /** The last failure's message, shown until the next attempt. */
  error?: string | undefined
  /** Localized chrome. */
  labels: CodeEditorLabels
}

/** One rendered line: its 1-based number and its highlighted runs. */
interface RenderedLine {
  number: number
  spans: readonly HighlightSpan[]
}

/** Split `text` into lines, dropping the trailing empty line a final newline creates. */
function toLines(text: string): string[] {
  const lines = text.split('\n')
  // "a\n" is one line of content plus a terminator, not two lines; shiki's
  // line array agrees, so the gutter counts match the file's real lines.
  if (lines.length > 1 && lines[lines.length - 1] === '') return lines.slice(0, -1)
  return lines
}

/**
 * Render the file editor.
 * @param props - see {@link CodeEditorProps}.
 * @returns the editor element.
 */
export function CodeEditor({
  path, savedText, text, onChange, onSave, onReload, saving, conflict, onOverwrite,
  loading, readOnly, error, labels,
}: CodeEditorProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const highlightRef = useRef<HTMLPreElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // The buffer the highlight layer was last tokenized from. Kept separate from
  // `text` so typing stays responsive while coloring trails a beat behind.
  const [highlighted, setHighlighted] = useState(text)
  // The preview switch is remembered together with the file it was set on, so
  // opening another file starts in the editor within the SAME render. Keeping a
  // bare boolean and clearing it from an effect would paint one frame of the new
  // file already rendered as a preview before that effect ran.
  const [preview, setPreview] = useState(false)

  // Opening another file starts in the editor: the switch describes one file's
  // view, and a leftover "on" would hide the file the operator just asked for.
  // The dialog unmounts this component between files, so this only has to catch
  // a same-instance path change.
  useEffect(() => { setPreview(false) }, [path])

  // Re-render when a lazily imported grammar finishes loading, so a file that
  // rendered plain while its grammar arrived picks up coloring.
  const grammarRevision = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount)
  const lang = languageOfPath(path)
  const previewKind = previewKindOfPath(path)

  useEffect(() => {
    if (text === highlighted) return
    const timer = setTimeout(() => { setHighlighted(text) }, RETOKENIZE_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [text, highlighted])

  const rendered = useMemo<readonly RenderedLine[]>(() => {
    void grammarRevision
    const lines = toLines(highlighted)
    const tokens = highlightLines(highlighted, lang)
    return lines.map((line, index) => ({
      number: index + 1,
      // A missing token array (unknown language, or a lazy grammar still
      // loading) renders the line as one unstyled run.
      spans: tokens?.[index] ?? [{ text: line, style: {} }],
    }))
  }, [highlighted, lang, grammarRevision])

  const dirty = text !== savedText

  // The two layers scroll as one: the textarea is the one the operator drives,
  // so its offset is copied onto the layers behind it rather than the reverse.
  const syncScroll = (): void => {
    const source = textareaRef.current
    if (source === null) return
    if (highlightRef.current !== null) {
      highlightRef.current.scrollTop = source.scrollTop
      highlightRef.current.scrollLeft = source.scrollLeft
    }
    if (gutterRef.current !== null) gutterRef.current.scrollTop = source.scrollTop
  }

  const save = (): void => { void onSave() }
  const showPreview = preview && previewKind !== undefined

  return (
    <div className={css.editor}>
      <div className={css.toolbar}>
        <span className={css.path} title={path}>{path}</span>
        <span className={css.status}>
          {loading && <span className={css.muted}>{labels.loading}</span>}
          {!loading && readOnly && <span className={css.muted}>{labels.readonly}</span>}
          {!loading && !readOnly && dirty && <span className={css.unsaved}>{labels.unsaved}</span>}
          {!loading && !readOnly && !dirty && !saving && <span className={css.muted}>{labels.saved}</span>}
          {!loading && !readOnly && saving && <span className={css.muted}>{labels.saving}</span>}
        </span>
        {!loading && previewKind !== undefined && (
          <label className={css.toggle}>
            <input
              type="checkbox"
              checked={preview}
              onChange={(event) => { setPreview(event.target.checked) }}
            />
            <span>{labels.preview}</span>
          </label>
        )}
        {!readOnly && !showPreview && (
          <>
            <Button size="sm" variant="outline" onClick={onReload} disabled={saving}>{labels.reload}</Button>
            <Button size="sm" variant="primary" onClick={save} disabled={saving || !dirty}>{labels.save}</Button>
          </>
        )}
      </div>
      {error !== undefined && <div className={css.error} role="alert">{error}</div>}
      {conflict && !readOnly && (
        <div className={css.conflict} role="alert">
          <span>{labels.conflict}</span>
          <Button size="sm" variant="outline" onClick={onReload}>{labels.reload}</Button>
          <Button size="sm" variant="outline" onClick={onOverwrite}>{labels.overwrite}</Button>
        </div>
      )}
      {showPreview
        ? (
          <ContentPreview
            kind={previewKind}
            text={text}
            labels={{
              frame: labels.previewFrame,
              copy: labels.copy,
              copied: labels.copied,
              footnotes: labels.footnotes,
              diagramError: labels.diagramError,
            }}
          />
        )
        : (
          <div className={css.panes}>
            <div ref={gutterRef} className={css.gutter} aria-hidden="true">
              {rendered.map(line => <div key={line.number} className={css.gutterLine}>{line.number}</div>)}
            </div>
            <div ref={scrollerRef} className={css.scroll}>
              <pre ref={highlightRef} className={css.highlight} aria-hidden="true">
                {rendered.map(line => (
                  <div key={line.number} className={css.line}>
                    {line.spans.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)}
                    {/* A zero-width filler keeps an empty line the same height as a
                        line with text, so the two layers stay aligned. */}
                    {line.spans.length === 0 && '\u200b'}
                  </div>
                ))}
              </pre>
              <textarea
                ref={textareaRef}
                className={css.input}
                value={text}
                readOnly={readOnly || loading}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                // Soft wrapping would break the two layers apart: the highlight layer
                // renders one line per source line, so a wrapped textarea would put
                // its glyphs on rows the colored layer never draws. `off` keeps a
                // long line on one row and scrolls it, which is also what makes the
                // horizontal scrollbar appear.
                wrap="off"
                aria-label={path}
                onChange={(event) => { onChange(event.target.value) }}
                onScroll={syncScroll}
                onKeyDown={(event) => {
                  // Ctrl/Cmd+S saves; preventing the default stops the browser's
                  // own save dialog from appearing on top of the editor.
                  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault()
                    if (!readOnly && !saving && dirty) save()
                  }
                }}
              />
            </div>
          </div>
        )}
      {/* The resolved language hint is exposed for tests and assistive tooling;
          the editor has no language picker — the extension decides. */}
      <span className={css.visuallyHidden} data-testid="editor-language">{lang ?? ''}</span>
    </div>
  )
}
