/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time. Rows expose only confirmed API-key state through accessible
 * solid configured or missing dots. Editing a row opens its card as a dialog
 * over the section rather than expanding the row, so the list stays a list and
 * the card keeps the width it has everywhere else on this page; the add flow
 * is a dialog carrying the dormant-provider select. In the first-run posture —
 * no provider on the page can serve requests yet — a whole-section provider
 * without a configured key opens that same dialog by itself, and only until
 * the user closes it. One card is open at a time, so closing one never
 * discards a draft in another. Every mutation writes through the wire, while a
 * provider removal first requires confirmation; the page re-renders from
 * pushed invalidations or the post-apply reload.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls this package's SlotMap merge (the two Models child slots).
import type {} from './slot-contract.ts'
import { AddModelDialog } from './AddModelDialog.tsx'
import { EditProviderDialog } from './EditProviderDialog.tsx'
import { ImageUnderstandingModelCard } from './ImageUnderstandingModelCard.tsx'
import { LightweightModelCard } from './LightweightModelCard.tsx'
import { deriveKeyRef, keyConfiguredOf, protocolChoices, providerUsable } from './store.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { LightweightModelStore } from './lightweight-model-store.ts'
import type { ImageUnderstandingModelStore } from './image-understanding-model-store.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { providerCopy } from './provider-identity.ts'
import type { ProviderIdentity } from './provider-identity.ts'
import type { zh } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  /** The lightweight-model preference store (one staged route over the catalog). */
  lightweight: LightweightModelStore
  /** The image-understanding preference store (one staged vision route). */
  imageUnderstanding: ImageUnderstandingModelStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
    /** Lightweight-model snapshot bound by the UI renderer as useLightweight. */
    lightweight: LightweightModelStore['store']
    /** Image-understanding snapshot bound by the UI renderer as useImageUnderstanding. */
    imageUnderstanding: ImageUnderstandingModelStore['store']
  }
  /** The Host operations the section and its cards invoke. */
  operations: ModelsOperations
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof zh) => string
}

/** The child slots this section declares and dispatches (see ./slot-contract.ts). */
type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer'

/** The child-slot dispatch function the renderer binds for the section. */
type ModelsRenderSlot = PropsRenderSlots<ModelsChildSlots>['renderSlot']

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call) plus the child-slot
 * dispatch seat. The seat is required: the renderer binds it at the render
 * call itself — unlike the inject face it is never absent at runtime — and a
 * direct render that forgets it fails to compile instead of mounting nothing.
 */
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & PropsRenderSlots<ModelsChildSlots>

type ModelsSectionFace = InjectFace<ModelsSectionInjected>

/** One existing row or dormant directory entry addressed by an editor action. */
interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** Writable credential identified under this page's conventional reference. */
  credentialRef?: string
  /** The adapter reports this route as one it does not ship (see {@link ProviderEditor}). */
  declared?: boolean
}

/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view.
 * @param operations - the page's Host operations.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  operations: ModelsOperations,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[]; credentialRef?: string },
): Promise<string | undefined> {
  if (target.credentialRef !== undefined) {
    const credential = await operations.removeCredential(target.credentialRef)
    if (credential !== undefined) return credential
  }
  const written = await operations.writeSettings(
    target.settingsNs,
    [{ op: 'unset', path: [...target.settingsPath] }],
    undefined,
  )
  if (written.kind !== 'written') return written.message
  await controller.load()
  return undefined
}

/**
 * Whether a whole-section provider still needs its first key: an unconfigured
 * credential opens its card as a dialog instead of leaving it a row. This is
 * the first-run posture alone — a user who can already reach some provider
 * gets an ordinary row with the missing-key dot, since nothing here is
 * blocking them.
 * @param row - the joined provider row.
 * @param anyUsable - whether any joined row can already serve requests.
 * @returns whether to open the card over the section.
 */
export function needsSetup(row: ProviderRow, anyUsable: boolean): boolean {
  if (anyUsable) return false
  if (row.entry.settingsPath.length > 0) return false
  return row.credential?.configured !== true
}

function targetOf(row: ProviderRow): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
    // Only declared routes may expose route-owned fields.
    ...row.entry.declared === true ? { declared: true } : {},
  }
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const {
    controller, lightweight, imageUnderstanding, useSnapshot, useLightweight,
    useImageUnderstanding, operations, schema, t, renderSlot,
  } = props
  if (
    controller === undefined || lightweight === undefined || imageUnderstanding === undefined
    || useSnapshot === undefined || useLightweight === undefined || useImageUnderstanding === undefined
    || operations === undefined || schema === undefined || t === undefined
  ) return null
  return (
    <Loaded
      injected={{
        controller, lightweight, imageUnderstanding, useSnapshot, useLightweight,
        useImageUnderstanding, operations, schema, t,
      }}
      renderSlot={renderSlot}
    />
  )
}

function Loaded({ injected, renderSlot }: { injected: ModelsSectionFace; renderSlot: ModelsRenderSlot }): ReactNode {
  const { controller, lightweight, imageUnderstanding, operations, schema, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  const lightweightState = injected.useLightweight(snapshot => snapshot)
  const imageUnderstandingState = injected.useImageUnderstanding(snapshot => snapshot)
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(() => new Set())

  const announceSaved = (target: ProviderIdentity): void => {
    // Announced only once the refreshed directory is in the snapshot the
    // notice reads its name from: an apply can rename the route, and the
    // target captured when the card opened still carries the old name.
    void controller.load().then(() => { setSavedTarget(target) })
  }

  /** Close the card the user opened: the row keeps its place in the list. */
  const closeEditor = (changed: boolean, row: ProviderRow): void => {
    setEditing(undefined)
    setAdding(false)
    if (changed) announceSaved(row.entry)
  }

  /**
   * Close the card the first-run posture opened by itself, which owns none of
   * the state above: the row-editor, add, and declare cards each own one of
   * those, so clearing them here would discard a draft the user opened beside
   * this card. Dismissal is this card's own — the provider falls back to an
   * ordinary row for the rest of the session, and reopens through Edit.
   */
  const closeSetup = (changed: boolean, row: ProviderRow): void => {
    setDismissedSetup(previous => new Set([...previous, row.entry.provider]))
    if (changed) announceSaved(row.entry)
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(operations, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  if (state.status === 'idle') void controller.load()
  // The card asks for its catalog only once the namespace it writes answers:
  // an unopened Models page owes the wire nothing.
  if (lightweightState.available) void lightweight.load()
  if (imageUnderstandingState.available) void imageUnderstanding.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  // The saved provider as the directory currently names it. The route id is
  // what the apply cannot change, so it is what the notice is keyed by; a row
  // the same apply removed keeps the captured identity, since nothing newer
  // exists to name it with.
  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }

  // One fact decides both first-run postures on this page and the onboarding
  // step: whether the user already has a provider to talk to.
  const anyUsable = state.rows.some(providerUsable)
  const configured = state.rows.filter(row => row.configured)
  const addable = state.rows.filter(row => !row.configured && row.entry.settingsNs !== '')
  // Hand-declared routes live in the pi-ai namespace, which is also the only
  // one whose schema names the protocols one may speak; without it mounted
  // there is nothing to declare and the entry point stays disabled.
  const protocols = protocolChoices(state.namespaces.get('llm-pi-ai'), schema)

  // The one card open over the section, and the row it belongs to. Edit opens
  // it; while nothing else is open, the first-run posture opens it itself for
  // the row whose missing key is what stands between the user and a working
  // model. A row a refresh dropped closes the card rather than leaving it
  // editing something the directory no longer lists.
  const editedRow = editing === undefined
    ? undefined
    : configured.find(row => row.entry.provider === editing.provider)
  const setupRow = editing === undefined && !adding
    ? configured.find(row => needsSetup(row, anyUsable) && !dismissedSetup.has(row.entry.provider))
    : undefined
  const cardRow = editedRow ?? setupRow
  const closeCard = editedRow === undefined ? closeSetup : closeEditor

  /** The one card, as the dialog every provider card on this page opens in. */
  const card = (row: ProviderRow): ReactNode => {
    const namespace = state.namespaces.get(row.entry.settingsNs)
    /* v8 ignore next -- the join marks a row configured only when its namespace resolved */
    if (namespace === undefined) return null
    return (
      <EditProviderDialog
        row={row}
        namespace={namespace}
        schema={schema}
        operations={operations}
        t={t}
        readOnly={!state.writable}
        renderSlot={renderSlot}
        onClose={(changed) => { closeCard(changed, row) }}
      />
    )
  }

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}
      <ul className={styles['rows']}>
        {configured.map((row) => {
          const target = targetOf(row)
          const open = cardRow === row
          const credentialConfigured = row.credential?.configured === true
          const credentialMissing = !credentialConfigured
            && row.apiKeyEnv !== undefined
            && row.credential?.configured === false
          return (
            <li key={row.entry.provider} className={styles['rowCard']}>
              <div className={styles['rowHead']}>
                <span className={styles['rowIdentity']}>
                  <span className={styles['rowName']}>{row.entry.displayName}</span>
                  {/* Only the adapter can tell a hand-declared route from a
                      shipped one it also has a stored profile for, so the tag
                      follows its answer and stays off when it gives none. */}
                  {row.entry.declared === true
                    ? <span className={styles['rowTag']}>{t('customTag')}</span>
                    : null}
                  {credentialConfigured
                    ? (
                      <span
                        className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`}
                        role="img"
                        aria-label={t('credentialConfigured')}
                        title={t('credentialConfigured')}
                      />
                    )
                    : credentialMissing
                      ? (
                        <span
                          className={`${styles['credentialDot']} ${styles['credentialDotMissing']}`}
                          role="img"
                          aria-label={t('credentialMissing')}
                          title={t('credentialMissing')}
                        />
                      )
                      : null}
                </span>
                <span className={styles['rowActions']}>
                  <button
                    type="button"
                    className={styles['secondaryButton']}
                    aria-label={providerCopy(t('editProvider'), target)}
                    onClick={() => {
                      setSavedTarget(undefined)
                      // One card at a time: an add dialog left open beside
                      // this card would be dismissed by closing either one,
                      // discarding the other's draft.
                      setAdding(false)
                      setEditing(target)
                    }}
                  >
                    {t('edit')}
                  </button>
                  {row.removable
                    ? (
                      <button
                        type="button"
                        className={styles['dangerButton']}
                        aria-label={providerCopy(t('removeProvider'), target)}
                        disabled={!state.writable}
                        onClick={() => {
                          setSavedTarget(undefined)
                          setDeleteFailure(undefined)
                          setDeleteTarget(target)
                        }}
                      >
                        {t('remove')}
                      </button>
                    )
                    : null}
                </span>
              </div>
              {/* The adapter-family extension area rides the card: while this
                  row's dialog is open it renders there, so the seat never
                  reaches the page twice for one row. */}
              {open
                ? null
                : renderSlot(
                  'settings.models.provider-card',
                  { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
                  { entryKey: row.entry.settingsNs },
                )}
            </li>
          )
        })}
      </ul>
      <LightweightModelCard
        state={lightweightState}
        t={t}
        onSelect={(key) => { lightweight.select(key) }}
        onClear={() => { lightweight.clear() }}
        onSave={() => { void lightweight.save() }}
        onDiscard={() => { lightweight.discard() }}
        onRetry={() => { lightweight.retry() }}
      />
      <ImageUnderstandingModelCard
        state={imageUnderstandingState}
        t={t}
        onSelect={(key) => { imageUnderstanding.select(key) }}
        onClear={() => { imageUnderstanding.clear() }}
        onSave={() => { void imageUnderstanding.save() }}
        onDiscard={() => { imageUnderstanding.discard() }}
        onRetry={() => { imageUnderstanding.retry() }}
      />
      <div className={styles['addBlock']}>
        {/* One entry point for the two ways to gain a provider — adopt one the
            adapter already knows, or declare one by its endpoint — because
            both start from the same question and the dialog asks it once. */}
        <button
          type="button"
          className={styles['addButton']}
          disabled={!state.writable || (addable.length === 0 && protocols.length === 0)}
          onClick={() => {
            setSavedTarget(undefined)
            setEditing(undefined)
            setAdding(true)
          }}
        >
          <IconPlusOutline16 size={14} />
          {t('add')}
        </button>
        {adding
          ? (
            <AddModelDialog
              rows={state.rows}
              addable={addable}
              namespaces={state.namespaces}
              protocols={protocols}
              /* v8 ignore next -- the create is only reachable with this namespace mounted */
              revision={state.namespaces.get('llm-pi-ai')?.revision ?? 0}
              schema={schema}
              operations={operations}
              t={t}
              readOnly={!state.writable}
              renderSlot={renderSlot}
              onClose={(added) => {
                setAdding(false)
                // A committed route is announced like any saved row: the
                // dialog is gone by then, and the notice is what says the
                // write landed rather than merely closed.
                if (added !== undefined) announceSaved({ provider: added, displayName: added })
              }}
            />
          )
          : null}
      </div>
      {cardRow === undefined ? null : card(cardRow)}
      {renderSlot('settings.models.footer', {})}
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
            deleteTarget.credentialRef === undefined
              ? t('deleteDescription')
              : t('deleteDescriptionWithCredential'),
            deleteTarget,
          )}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
