/**
 * The page's one way to gain a provider: a dialog that either adopts a route
 * the adapter already knows or declares one it does not, decided by what the
 * user supplies — a provider picked from the directory, or an endpoint typed
 * by hand.
 *
 * The two paths keep their own cards: adopting a directory route is the
 * provider editor over an address that already exists, while declaring a route
 * is a create that has to choose the id, the protocol, and at least one model
 * before anything can be stored. Neither is a variant of the other, so the
 * dialog is a chooser in front of the two cards rather than a third one.
 *
 * The chooser stays reachable from either card (its own dismiss closes the
 * whole dialog; the card's cancel returns here), because a half-typed draft is
 * worth less than the choice behind it — and because a route the directory no
 * longer lists is a reason to switch, not to start over.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { ProviderEditor } from './ProviderEditor.tsx'
import { keyConfiguredOf } from './store.ts'
import type { ProviderRow } from './store.ts'
import type { ProviderCardRenderSlot } from './slot-contract.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { zh } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Where the dialog stands: on the chooser, or inside one of the two cards. */
type AddStage =
  | { readonly kind: 'choose' }
  | { readonly kind: 'provider'; readonly provider: string }
  | { readonly kind: 'manual'; readonly baseURL: string }

/** Props of {@link AddModelDialog}. */
export interface AddModelDialogProps {
  /** Every joined row: a card already open resolves from these, so a refresh
   * that configures its route mid-draft does not tear the card down. */
  rows: readonly ProviderRow[]
  /** The rows the chooser offers — not yet configured, with a settings address. */
  addable: readonly ProviderRow[]
  /** Namespace views by name, so a chosen route's schema is its own namespace. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** Wire protocols a hand-declared route may speak. */
  protocols: readonly string[]
  /** `llm-pi-ai` revision the create is checked against. */
  revision: number
  /** Settings-owned synchronous schema and immutable path operations. */
  schema: SettingsSchemaOperations
  /** The Host operations the cards write and interrogate through. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof zh) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Child-slot dispatch for the provider-card area of a picked route's card. */
  renderSlot: ProviderCardRenderSlot
  /**
   * Close the dialog. `added` names the route the dialog committed — picking a
   * directory route or declaring one by hand both end in a stored profile — and
   * is absent when the dialog simply went away.
   */
  onClose: (added?: string) => void
}

/**
 * Render the add-model dialog.
 * @param props - the addable directory rows, both cards' dependencies, and copy.
 * @returns the dialog, or null while closed.
 */
export function AddModelDialog(props: AddModelDialogProps): ReactNode {
  const { addable, t } = props
  const [stage, setStage] = useState<AddStage>({ kind: 'choose' })
  const [manualUrl, setManualUrl] = useState('')
  const trimmedUrl = manualUrl.trim()
  const row = stage.kind === 'provider'
    ? props.rows.find(candidate => candidate.entry.provider === stage.provider)
    : undefined
  const namespace = row === undefined ? undefined : props.namespaces.get(row.entry.settingsNs)

  /** Close the dialog, dropping whatever the open card was drafting. */
  const dismiss = (): void => {
    setStage({ kind: 'choose' })
    setManualUrl('')
    props.onClose()
  }

  /** Settle one card: a commit closes the dialog, a cancel returns to the chooser. */
  const settle = (changed: boolean, added?: string): void => {
    if (changed) {
      props.onClose(added)
      return
    }
    setStage({ kind: 'choose' })
    setManualUrl('')
  }
  return (
    <Modal
      open
      onClose={dismiss}
      closeLabel={t('close')}
      title={t('add')}
      description={t('addDescription')}
      className={styles['addDialog'] as string}
      contentClassName={styles['addDialogContent'] as string}
    >
      <div className={styles['providerDialogBody']}>
        {stage.kind !== 'manual' && (
          <div className={styles['addDialogStep']}>
            {addable.length === 0
              ? <p className={styles['advancedHint']}>{t('addNoneAddable')}</p>
              : (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('provider')}</span>
                  <select
                    className={`${styles['input']} ${styles['selectInput']}`}
                    value={stage.kind === 'provider' ? stage.provider : ''}
                    aria-label={t('provider')}
                    onChange={(event) => {
                      if (event.target.value === '') return
                      setStage({ kind: 'provider', provider: event.target.value })
                    }}
                  >
                    {/* The placeholder is the chooser's resting state; a card
                        already open names the route it edits instead. */}
                    {stage.kind === 'choose'
                      ? <option value="">{t('addProviderPlaceholder')}</option>
                      : null}
                    {addable.map(candidate => (
                      <option key={candidate.entry.provider} value={candidate.entry.provider}>
                        {candidate.entry.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            {stage.kind === 'provider' ? null : (
              <div className={styles['field']}>
                <span className={styles['fieldLabel']}>{t('addManualUrl')}</span>
                <div className={styles['addManualRow']}>
                  <input
                    className={styles['input']}
                    type="text"
                    value={manualUrl}
                    placeholder={t('customBaseUrlPlaceholder')}
                    aria-label={t('addManualUrl')}
                    disabled={props.readOnly || props.protocols.length === 0}
                    onChange={(event) => { setManualUrl(event.target.value) }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className={styles['addManualContinue']}
                    disabled={props.readOnly || props.protocols.length === 0 || trimmedUrl.length === 0}
                    onClick={() => { setStage({ kind: 'manual', baseURL: trimmedUrl }) }}
                  >
                    {t('addManualContinue')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {stage.kind === 'choose' ? null : (
          <button
            type="button"
            className={styles['linkButton']}
            onClick={() => { setStage({ kind: 'choose' }) }}
          >
            {t('addBack')}
          </button>
        )}
        {stage.kind === 'manual'
          ? (
            <CustomProviderCard
              taken={props.rows.map(candidate => candidate.entry.provider)}
              protocols={props.protocols}
              revision={props.revision}
              operations={props.operations}
              t={t}
              readOnly={props.readOnly}
              initialBaseURL={stage.baseURL}
              onClose={(changed, added) => { settle(changed, added) }}
            />
          )
          : stage.kind === 'provider' && row !== undefined && namespace !== undefined
            ? (
              <>
                <ProviderEditor
                  key={row.entry.provider}
                  provider={row.entry.provider}
                  displayName={row.entry.displayName}
                  hideTitle
                  namespace={namespace}
                  schema={props.schema}
                  settingsPath={row.entry.settingsPath}
                  operations={props.operations}
                  t={t}
                  readOnly={props.readOnly}
                  {...row.entry.declared === true ? { declared: true } : {}}
                  onClose={(changed) => { settle(changed, row.entry.provider) }}
                />
                {/* The adapter-family extension area, keyed by the namespace
                    the row belongs to: a plugin distributed outside this
                    package reaches a route it is being added for through the
                    same seat it reaches a saved one. */}
                {props.renderSlot(
                  'settings.models.provider-card',
                  {
                    provider: row.entry,
                    configured: row.configured,
                    keyConfigured: keyConfiguredOf(row),
                  },
                  { entryKey: row.entry.settingsNs },
                )}
              </>
            )
            : null}
      </div>
    </Modal>
  )
}
