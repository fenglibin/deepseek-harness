/**
 * The skill file editor: a syntax-highlighted layer beneath a transparent
 * textarea.
 *
 * The two layers share one font, one line height, and one padding, and the
 * textarea drives their common scroll offset, so the caret sits exactly on the
 * glyph it edits while shiki colors the glyph behind it. Soft wrapping is off:
 * a wrapped line occupies one row in the highlight layer but several in the
 * textarea, which would push every following line out of alignment.
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ReactNode, UIEvent } from 'react'
import { grammarLoadCount, highlightLines, subscribeGrammarLoaded } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SkillsSection.module.css'

/**
 * Derive the grammar hint for one file.
 *
 * The highlighter's alias table is keyed by file extension as well as by
 * language name, so the extension is already the hint its own lookup expects;
 * an unknown extension resolves to plain text inside the highlighter rather
 * than needing a second table here.
 * @param path - forward-slash relative path of the file.
 * @returns the extension without its dot, lowercased; empty when the name carries none.
 */
export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Props of {@link SkillFileEditor}. */
export interface SkillFileEditorProps {
  /** Current text. */
  readonly value: string
  /** Grammar hint; a file extension is one, which is what callers pass. */
  readonly language: string
  /** Accessible name of the editor, which is the file it shows. */
  readonly label: string
  /** Whether the editor accepts typing. */
  readonly editable: boolean
  /** Replace the text. */
  readonly onChange: (value: string) => void
}

/** The editor's highlight layer and input. */
export function SkillFileEditor({ value, language, label, editable, onChange }: SkillFileEditorProps): ReactNode {
  // A grammar loads lazily the first time its language renders. This snapshot's
  // only job is to re-render once it registers, so the first file opened in a
  // given language picks up highlighting instead of staying plain.
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const lines = useMemo(() => highlightLines(value, language), [value, language, loaded])
  const layerRef = useRef<HTMLPreElement>(null)

  const syncScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const layer = layerRef.current
    if (layer === null) return
    layer.scrollTop = event.currentTarget.scrollTop
    layer.scrollLeft = event.currentTarget.scrollLeft
  }, [])

  return (
    <div className={css.editor}>
      <pre ref={layerRef} className={css.editorHighlight} aria-hidden="true">
        {lines === undefined
          ? <span className={css.editorLine}>{value}</span>
          : lines.map((line, index) => (
            <span className={css.editorLine} key={index}>
              {line.map((span, position) => <span key={position} style={span.style}>{span.text}</span>)}
            </span>
          ))}
      </pre>
      <textarea
        className={css.editorInput}
        value={value}
        readOnly={!editable}
        spellCheck={false}
        wrap="off"
        aria-label={label}
        onChange={(event) => { onChange(event.target.value) }}
        onScroll={syncScroll}
      />
    </div>
  )
}
