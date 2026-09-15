/**
 * In-place `mcp.json` editor: a lightweight highlighted textarea. The colored
 * token layer and the transparent-text textarea share one font metric AND one
 * line-breaking rule (`white-space: pre-wrap` + `word-break: break-all`), so
 * soft-wrapping happens at the same column in both layers and the caret always
 * sits on the glyph it edits.
 *
 * Scrolling is owned by the outer `scroller`, not the textarea: the textarea
 * hides its own scrollbars (`overflow: hidden`) and expands to its content
 * height, so the two layers never drift by a scrollbar width — the exact
 * failure that used to leave the caret short of a line end and drop typed
 * characters a row below where they were aimed.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { McpHelp } from './McpHelp.tsx'
import type { McpKey } from './locales.ts'
import styles from './McpJsonEditor.module.css'

/** One highlighted run of JSON text. */
type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'plain'

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
  return tokens
}

/** The highlight layer content for one token list, one span per token. */
function Highlight({ tokens }: { tokens: JsonToken[] }): ReactNode {
  return tokens.map((token, index) => (
    <span key={index} className={styles[`tok${token.kind.charAt(0).toUpperCase()}${token.kind.slice(1)}`]}>
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
  /** Dialog title; defaults to the whole-document title. */
  title?: string
  /** Section copy. */
  t: (key: McpKey) => string
}

/**
 * Render the `mcp.json` editor.
 * @param props - the initial text, the write/close actions, and the section copy.
 * @returns the editor dialog.
 */
export function McpJsonEditor(props: McpJsonEditorProps): ReactNode {
  const { text, opening, error, onSave, onClose, title, t } = props
  const [draft, setDraft] = useState(text)
  const [invalid, setInvalid] = useState<string | undefined>(undefined)
  const [helpOpen, setHelpOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Pull the freshly read text once the read settles; a later save closes the
  // editor, so this cannot overwrite an edit the user is still making.
  useEffect(() => {
    setDraft(text)
  }, [text])

  // Expand the textarea to its content height so it never scrolls internally.
  // The outer scroller owns all scrolling, which keeps the highlight layer
  // (absolutely positioned over the textarea) at the exact same row as the
  // caret — no scrollbar-width drift, no trailing-row mismatch.
  useLayoutEffect(() => {
    const input = inputRef.current
    if (input === null) return
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }, [draft])

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
    <>
      <Modal
        open
        onClose={onClose}
        title={title ?? t('editorTitle')}
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
        {/* The hint and its help link are one sentence, so they render as one
          line: the Modal's `description` seat takes a string only, and the
          link has to sit inside the sentence rather than under it. */}
        <p className={styles['hint']}>
          <span>{t('editorHint')}</span>{' '}
          <button
            type="button"
            className={styles['helpLink']}
            onClick={() => { setHelpOpen(true) }}
          >
            {t('help')}
          </button>
        </p>
        <div className={styles['scroller']}>
          <div className={styles['content']}>
            <div className={styles['highlight']} aria-hidden="true" data-testid="mcp-json-highlight">
              <Highlight tokens={tokens} />
            </div>
            <textarea
              ref={inputRef}
              className={styles['input']}
              value={draft}
              wrap="soft"
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value)
                setInvalid(undefined)
              }}
            />
          </div>
        </div>
        {invalid === undefined ? null : <p className={styles['error']} role="alert">{invalid}</p>}
        {error === null || invalid !== undefined ? null : <p className={styles['error']} role="alert">{t('saveFailed')}: {error}</p>}
      </Modal>
      <McpHelp open={helpOpen} onClose={() => { setHelpOpen(false) }} t={t} />
    </>
  )
}
