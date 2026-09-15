/**
 * The MCP configuration help dialog: the reference a user needs while writing a
 * server entry, reachable from the add and edit dialogs.
 *
 * It is a separate dialog rather than inline text because the editor is already
 * the tallest surface in settings; a user who knows the format should not have
 * to scroll past documentation every time. Every string, including each JSON
 * example, comes from the `settings.mcp` locale dictionary — the copy is
 * product-visible, and this package keeps no product text in components.
 */

import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpKey } from './locales.ts'
import styles from './McpHelp.module.css'

/** Props delivered by {@link McpSection} to the help dialog. */
export interface McpHelpProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Close the dialog. */
  onClose: () => void
  /** Section copy. */
  t: (key: McpKey) => string
}

/**
 * One titled section: a heading, an explanation, and a copyable example. A
 * `label` distinguishes sibling examples that share one heading, which is the
 * case for the two transports — they answer the same question ("what does an
 * entry look like"), so they share a heading and differ by label.
 */
function Section(props: {
  heading: string
  note: string
  example: string
  extra?: string
  label?: string
}): ReactNode {
  const { heading, note, example, extra, label } = props
  return (
    <section className={styles['section']}>
      {heading === '' ? null : <h3 className={styles['heading']}>{heading}</h3>}
      {label === undefined ? null : <p className={styles['label']}>{label}</p>}
      <p className={styles['note']}>{note}</p>
      {/* Not a `code` element styled inline: the examples are multi-line, and
          preserving their whitespace is what makes them pasteable as-is. */}
      <pre className={styles['example']}><code>{example}</code></pre>
      {extra === undefined ? null : <p className={styles['note']}>{extra}</p>}
    </section>
  )
}

/**
 * Render the MCP configuration help dialog.
 * @param props - the open state, the close action, and the section copy.
 * @returns the help dialog, or null while closed.
 */
export function McpHelp({ open, onClose, t }: McpHelpProps): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('helpTitle')}
      closeLabel={t('close')}
      className={styles['dialog'] as string}
      bodyClassName={styles['body'] as string}
      footer={(
        <Button variant="outline" autoFocus onClick={onClose}>
          {t('close')}
        </Button>
      )}
    >
      <p className={styles['intro']}>{t('helpIntro')}</p>
      <Section
        heading={t('helpBasicHeading')}
        label={t('helpBasicStdioLabel')}
        note={t('helpBasicStdioNote')}
        example={t('helpBasicStdioExample')}
      />
      <Section
        heading=""
        label={t('helpBasicHttpLabel')}
        note={t('helpBasicHttpNote')}
        example={t('helpBasicHttpExample')}
      />
      <Section
        heading={t('helpOAuthHeading')}
        note={t('helpOAuthNote')}
        example={t('helpOAuthExample')}
        extra={t('helpOAuthSteps')}
      />
      <Section
        heading={t('helpOptionalHeading')}
        note={t('helpOptionalNote')}
        example={t('helpOptionalExample')}
      />
      <p className={styles['footnote']}>{t('helpFileNote')}</p>
    </Modal>
  )
}
