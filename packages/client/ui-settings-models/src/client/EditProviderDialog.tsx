/**
 * One saved provider's card as a dialog, opened by 编辑 and, while no provider
 * can serve requests yet, by the page itself for the route whose missing key
 * is the one thing standing between the user and a working model.
 *
 * The dialog is the editor's only home on this page: a row expands into
 * nothing, so the list stays a list of rows and the card is always the same
 * width wherever it opens — the width the add dialog gives the same
 * {@link ProviderEditor}. Dismissing it, by whichever control, discards the
 * draft it holds rather than keeping a half-typed key alive behind the rows.
 */

import type { ReactNode } from 'react'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { providerCopy } from './provider-identity.ts'
import { ProviderEditor } from './ProviderEditor.tsx'
import { keyConfiguredOf } from './store.ts'
import type { ProviderRow } from './store.ts'
import type { ProviderCardRenderSlot } from './slot-contract.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link EditProviderDialog}. */
export interface EditProviderDialogProps {
  /** The joined row the card edits: its identity, settings address, and live state. */
  row: ProviderRow
  /** The owning namespace view (schema, layers, secrets). */
  namespace: SettingsNamespaceView
  /** Settings-owned synchronous schema and immutable path operations. */
  schema: SettingsSchemaOperations
  /** The Host operations the card writes and interrogates through. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Child-slot dispatch for the provider-card area of this card. */
  renderSlot: ProviderCardRenderSlot
  /** Close the dialog; `changed` reports whether an Apply committed. */
  onClose: (changed: boolean) => void
}

/**
 * Render one provider's card as a dialog.
 * @param props - the edited row, the card's dependencies, and copy.
 * @returns the dialog over the section.
 */
export function EditProviderDialog(props: EditProviderDialogProps): ReactNode {
  const { row, t } = props
  return (
    <Modal
      open
      onClose={() => { props.onClose(false) }}
      closeLabel={t('close')}
      title={providerCopy(t('editProvider'), row.entry)}
      className={styles['editDialog'] as string}
      contentClassName={styles['editDialogContent'] as string}
    >
      <div className={styles['providerDialogBody']}>
        <ProviderEditor
          provider={row.entry.provider}
          displayName={row.entry.displayName}
          hideTitle
          namespace={props.namespace}
          schema={props.schema}
          settingsPath={row.entry.settingsPath}
          operations={props.operations}
          t={t}
          readOnly={props.readOnly}
          {...row.entry.declared === true ? { declared: true } : {}}
          onClose={props.onClose}
        />
        {/* The adapter-family extension area, keyed by the namespace this row
            belongs to: a plugin distributed outside this package reaches the
            card here exactly as it reaches the add dialog's card. */}
        {props.renderSlot(
          'settings.models.provider-card',
          {
            provider: row.entry,
            configured: row.configured,
            keyConfigured: keyConfiguredOf(row),
          },
          { entryKey: row.entry.settingsNs },
        )}
      </div>
    </Modal>
  )
}
