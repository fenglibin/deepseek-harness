/**
 * In-place `mcp.json` editor: a highlighted textarea (a colored token layer
 * behind a transparent-text textarea) with a format action and a validated
 * save. The editor stages what the user types; nothing reaches the Host until
 * save, which parses the JSON locally, refuses a malformed document in place,
 * and only then writes through the document store.
 *
 * The highlight layer mirrors the textarea's content and metrics: the two
 * layers share font, line-height, padding, and box-sizing, and the highlight
 * layer renders a trailing newline sentinel when the draft does not end in
 * one, so its scroll height matches the textarea's and the caret stays aligned
 * with the colored text on every cursor move. A `ResizeObserver` resyncs the
 * highlight layer when the user drags the textarea's resize handle.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpKey } from './locales.ts'
import styles from './McpJsonEditor.module.css'

/** One highlighted run of JSON text. */
type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'plain' | 'sentinel'

/** One classified slice of the JSON source. */
interface JsonToken {
  kind: JsonTokenKind
  text: string
}

/**
 * Classify JSON text into tokens for the highlight layer. The classifier is
 * deliberately forgiving: unparseable text still tokenizes (as strings and
 * plain runs) so the highlight layer stays aligned with the textarea even
 * while the user edits; validation is the save path's job, not the highlight's.
 *
 * When the text does not end in a newline, a final `plain` token carrying one
 * `\n` is appended: a `<textarea>` reserves a trailing row for the caret, so
 * the highlight layer must reserve the same row or the caret drifts up one
 * line as the user moves the cursor through the last actual row.
 * @param text - the JSON source.
 * @returns one token per classified slice, covering the whole text in order.
 */
function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = []
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === '"') {
      const start = i
      i += 1
      while (i < text.length) {
        if (text.charAt(i) === '\\') { i += 2; continue }
        if (text.charAt(i) === '"') { i += 1; break }
        i += 1
      }
      const run = text.slice(start, i)
      let j = i
      while (j < text.length && /\s/.test(text.charAt(j))) j += 1
      tokens.push({ kind: text.charAt(j) === ':' ? 'key' : 'string', text: run })
      continue
    }
    if ('{}[]:,'.includes(ch)) {
      tokens.push({ kind: 'punct', text: ch })
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      let j = i
      while (j < text.length && /\s/.test(text.charAt(j))) j += 1
      tokens.push({ kind: 'plain', text: text.slice(i, j) })
      i = j
      continue
    }
    const match = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    const word = match?.[1]
    if (word === undefined) {
      tokens.push({ kind: 'plain', text: ch })
      i += 1
      continue
    }
    const kind = word === 'true' || word === 'false' ? 'boolean' : word === 'null' ? 'null' : 'number'
    tokens.push({ kind, text: word })
    i += word.length
  }
  // Sentinel: keep the highlight layer's last row aligned with the textarea's
  // reserved caret row when the draft has no trailing newline. The kind is
  // `sentinel`, not `plain`, so the highlight layer can give it the same
  // foreground color (it carries no semantic coloring of its own) while a
  // test can prove it was appended by counting `sentinel` tokens.
  if (text.length === 0 || text.charAt(text.length - 1) !== '\n') {
    tokens.push({ kind: 'sentinel', text: '\n' })
  }
  return tokens
}

/** The highlight layer content for one token list, one span per token. */
function Highlight({ tokens }: { tokens: JsonToken[] }): ReactNode {
  return tokens.map((token, index) => (
    <span
      key={index}
      className={styles[`tok${token.kind.charAt(0).toUpperCase()}${token.kind.slice(1)}`]}
      {...(token.kind === 'sentinel' ? { 'data-sentinel': 'true' } : {})}
    >
      {token.text}
    </span>
  ))
}

/** Props delivered by {@link McpSection} to the `mcp.json` editor. */
export interface McpJsonEditorProps {
  /** The current document text the editor starts from. */
  text: string
  /** Whether a read or write is crossing the wire; disables the save action. */
  opening: boolean
  /** Last read/write diagnostic, when one was reported. */
  error: string | null
  /** Persist one validated document text. */
  onSave: (text: string) => void
  /** Close the editor without saving. */
  onClose: () => void
  /** Section copy. */
  t: (key: McpKey) => string
}

/**
 * Render the `mcp.json` editor.
 * @param props - the initial text, the write/close actions, and the section copy.
 * @returns the editor dialog.
 */
export function McpJsonEditor(props: McpJsonEditorProps): ReactNode {
  const { text, opening, error, onSave, onClose, t } = props
  const [draft, setDraft] = useState(text)
  const [invalid, setInvalid] = useState<string | undefined>(undefined)
  const highlightRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Pull the freshly read text once the read settles; a later save closes the
  // editor, so this cannot overwrite an edit the user is still making.
  useEffect(() => {
    setDraft(text)
  }, [text])

  /**
   * Mirror the textarea's scroll position on the highlight layer. Mouse wheel
   * and scroll-bar drags fire `onScroll`; arrow keys, clicks, and `Ctrl+End`
   * re-anchor the caret without scrolling, so a follow-up `onKeyUp` / `onClick`
   * pulls the caret row into view on the highlight layer too.
   */
  const syncScroll = (): void => {
    const input = inputRef.current
    const highlight = highlightRef.current
    if (input === null || highlight === null) return
    highlight.scrollTop = input.scrollTop
    highlight.scrollLeft = input.scrollLeft
  }

  // Dragging the textarea's resize handle changes its rendered height but
  // not its scrollTop, so the highlight layer would fall behind. Watch the
  // textarea's `clientHeight` and pin the highlight's `height` to match.
  useLayoutEffect(() => {
    const input = inputRef.current
    const highlight = highlightRef.current
    if (input === null || highlight === null) return
    const sync = (): void => { highlight.style.height = `${input.clientHeight}px` }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(input)
    return () => { observer.disconnect() }
  }, [])

  /** Format the current draft, reporting the parse failure in place when it cannot. */
  const format = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (parseError) {
      setInvalid(`${t('invalidJson')}: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
      return
    }
    setDraft(`${JSON.stringify(parsed, null, 2)}\n`)
    setInvalid(undefined)
  }

  /** Validate the draft, then hand it to the caller only when it parses. */
  const submit = (): void => {
    try {
      JSON.parse(draft)
    } catch (parseError) {
      setInvalid(`${t('invalidJson')}: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
      return
    }
    setInvalid(undefined)
    onSave(draft)
  }

  const tokens = tokenizeJson(draft)

  return (
    <Modal
      open
      onClose={onClose}
      title={t('editorTitle')}
      closeLabel={t('close')}
      className={styles['dialog'] as string}
      footer={(
        <>
          <Button variant="outline" disabled={opening} onClick={format}>
            {t('format')}
          </Button>
          <Button variant="outline" autoFocus disabled={opening} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="outline" disabled={opening} onClick={submit}>
            {opening ? t('saving') : t('save')}
          </Button>
        </>
      )}
    >
      <div className={styles['editor']}>
        <div ref={highlightRef} className={styles['highlight']} aria-hidden="true" data-testid="mcp-json-highlight">
          <Highlight tokens={tokens} />
        </div>
        <textarea
          ref={inputRef}
          className={styles['input']}
          value={draft}
          wrap="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value)
            setInvalid(undefined)
          }}
          onScroll={syncScroll}
          onKeyUp={syncScroll}
          onClick={syncScroll}
        />
      </div>
      {invalid === undefined ? null : <p className={styles['error']} role="alert">{invalid}</p>}
      {error === null || invalid !== undefined ? null : <p className={styles['error']} role="alert">{t('saveFailed')}: {error}</p>}
    </Modal>
  )
}
