/**
 * The delivery-discipline help dialog: the reference a user needs while
 * deciding how to configure the policy, reached from the card's Help link.
 *
 * It is a dialog rather than inline text because the card is a form: a user who
 * already knows the policy should not have to scroll past the whole grading
 * reference to reach the fields. Every string comes from the
 * `settings.plugins` locale dictionary — the copy is product-visible, and this
 * package keeps no product text in components.
 */

import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import styles from './DeliveryHelp.module.css'

/** Props delivered by the delivery card to the help dialog. */
export interface DeliveryHelpProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Close the dialog. */
  onClose: () => void
  /** Section copy. */
  t: (key: PluginsSettingsLocaleKey) => string
}

/** One titled block: a heading followed by its paragraphs. */
function Section(props: { headingKey: PluginsSettingsLocaleKey; noteKey: PluginsSettingsLocaleKey; t: DeliveryHelpProps['t'] }): ReactNode {
  return (
    <section className={styles['section']}>
      <h3 className={styles['heading']}>{props.t(props.headingKey)}</h3>
      <p className={styles['note']}>{props.t(props.noteKey)}</p>
    </section>
  )
}

/**
 * Render the delivery-discipline help dialog.
 * @param props - the open state, the close action, and the copy reader.
 * @returns the help dialog, or null while closed.
 */
export function DeliveryHelp({ open, onClose, t }: DeliveryHelpProps): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('deliveryTitle')}
      closeLabel={t('close')}
      className={styles['dialog'] as string}
      bodyClassName={styles['body'] as string}
      footer={(
        <Button variant="outline" autoFocus onClick={onClose}>
          {t('close')}
        </Button>
      )}
    >
      <p className={styles['intro']}>{t('deliveryHelpIntro')}</p>

      <section className={styles['section']}>
        <h3 className={styles['heading']}>{t('deliveryHelpTiersHeading')}</h3>
        <div className={styles['tier']}>
          <p className={styles['tierName']}>{t('deliveryTierL0Name')}</p>
          <p className={styles['note']}>{t('deliveryHelpTierL0')}</p>
        </div>
        <div className={styles['tier']}>
          <p className={styles['tierName']}>{t('deliveryTierL1Name')}</p>
          <p className={styles['note']}>{t('deliveryHelpTierL1')}</p>
        </div>
        <div className={styles['tier']}>
          <p className={styles['tierName']}>{t('deliveryTierL2Name')}</p>
          <p className={styles['note']}>{t('deliveryHelpTierL2')}</p>
        </div>
      </section>

      <Section headingKey="deliveryHelpFlowHeading" noteKey="deliveryHelpFlowNote" t={t} />
      <Section headingKey="deliveryHelpArtifactsHeading" noteKey="deliveryHelpArtifactsNote" t={t} />

      <section className={styles['section']}>
        <h3 className={styles['heading']}>{t('deliveryHelpVerifyHeading')}</h3>
        <p className={styles['note']}>{t('deliveryHelpVerifyIntro')}</p>
        {(['deliveryHelpVerifyStep1', 'deliveryHelpVerifyStep2',
          'deliveryHelpVerifyStep3', 'deliveryHelpVerifyStep4'] as const).map(key => (
          <p key={key} className={styles['step']}>{t(key)}</p>
        ))}
        <p className={styles['note']}>{t('deliveryHelpVerifyRelease')}</p>
      </section>

      <section className={styles['section']}>
        <h3 className={styles['heading']}>{t('deliveryHelpCoversHeading')}</h3>
        <p className={styles['note']}>{t('deliveryHelpCoversNote')}</p>
        {/* Not a `code` element styled inline: the example is multi-line, and
            preserving its whitespace is what makes it pasteable as-is. */}
        <pre className={styles['example']}><code>{t('deliveryHelpCoverExample')}</code></pre>
      </section>

      <Section headingKey="deliveryHelpConfigHeading" noteKey="deliveryHelpConfigNote" t={t} />

      <p className={styles['footnote']}>{t('deliveryHelpFooter')}</p>
    </Modal>
  )
}
