/**
 * The full README of one plugin, opened from its inventory card.
 *
 * The document is fetched when the dialog opens and rendered with the same
 * Markdown pipeline the conversation uses, so a README reads the way its
 * author wrote it: tables stay tables, fences stay highlighted, and a
 * ```mermaid diagram renders as a diagram. Every failure has its own sentence
 * rather than an empty panel — no README, and a read that was refused, are
 * different things to the reader.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText, Modal, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { clsx } from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ReadmeDialog.module.css'

/** Localized copy for this dialog. */
type Translate = PropsLocale<'settings.pluginInventory'>['t']

/** One plugin's README, once the read settles. */
export interface ReadmeDocument {
  /** Name it was found under: `README.zh.md` or `README.md`. */
  readonly name: string
  /** The body, with its frontmatter block removed. */
  readonly text: string
}

/** The open dialog's read. */
type ReadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly document: ReadmeDocument }
  | { readonly status: 'empty' }
  | { readonly status: 'error' }

/**
 * Show one plugin's whole README.
 * @param props.moduleName - the plugin module the README belongs to.
 * @param props.readmeName - the README file the inventory found.
 * @param props.read - fetch the document; rejected means the read was refused.
 * @param props.onClose - dismiss the dialog.
 * @param props.t - this package's locale seat.
 * @returns the modal, or null when nothing is open.
 */
export function ReadmeDialog({ moduleName, readmeName, read, onClose, t }: {
  readonly moduleName: string
  readonly readmeName: string
  readonly read: (moduleName: string) => Promise<ReadmeDocument | undefined>
  readonly onClose: () => void
  readonly t: Translate
}): ReactNode {
  const [state, setState] = useState<ReadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    void read(moduleName).then(
      (document) => {
        if (current) setState(document === undefined ? { status: 'empty' } : { status: 'ready', document })
      },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [read, moduleName, attempt])

  // A new identity mid-document would discard the settled render, so the
  // labels are built once per locale rather than per render.
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('codeCopy'), copiedLabel: t('codeCopied') },
    footnotes: t('footnotes'),
  }), [t])
  const diagrams = useMemo(() => ({ errorLabel: t('diagramError') }), [t])

  return (
    <Modal
      open
      onClose={onClose}
      title={t('readmeTitle', { name: moduleName, readme: readmeName })}
      closeLabel={t('readmeClose')}
      className={clsx(css.dialog)}
      contentClassName={clsx(css.content)}
      bodyClassName={clsx(css.body)}
      footer={state.status === 'error'
        ? (
          <button type="button" className={css.retry} onClick={() => { setAttempt(value => value + 1) }}>
            {t('readmeRetry')}
          </button>
        )
        : undefined}
    >
      {state.status === 'loading' ? <p className={css.note}>{t('readmeLoading')}</p> : null}
      {state.status === 'empty' ? <p className={css.note}>{t('readmeEmpty')}</p> : null}
      {state.status === 'error' ? <p className={css.failure} role="alert">{t('readmeError')}</p> : null}
      {state.status === 'ready'
        ? (
          <MarkdownText
            text={state.document.text}
            labels={labels}
            diagrams={diagrams}
          />
        )
        : null}
    </Modal>
  )
}
