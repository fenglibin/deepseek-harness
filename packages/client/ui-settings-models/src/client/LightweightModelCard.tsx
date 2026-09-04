/**
 * Lightweight-model card: one route picked from the live model catalog, or the
 * explicit absence of one. The card owns no data — every fact and action
 * arrives through props, so a scope that refuses writes disables the picker
 * and says so rather than staging a choice it cannot save.
 */

import { useId } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LightweightModelState } from './lightweight-model-store.ts'
import type { en } from './locales.ts'
import styles from './LightweightModelCard.module.css'

/** Props of {@link LightweightModelCard}: one card state plus its actions. */
export interface LightweightModelCardProps {
  /** Current card snapshot. */
  state: LightweightModelState
  /** Models-page copy. */
  t: (key: keyof typeof en) => string
  /** Stage one catalog route by its opaque key. */
  onSelect: (key: string) => void
  /** Stage the absence of a route. */
  onClear: () => void
  /** Persist the staged choice. */
  onSave: () => void
  /** Drop the staged choice. */
  onDiscard: () => void
  /** Request the model catalog again after a failed load. */
  onRetry: () => void
}

/**
 * Render the lightweight-model picker.
 * @param props - card state and callbacks.
 * @returns the card.
 */
export function LightweightModelCard(props: LightweightModelCardProps): ReactNode {
  const { state, t, onSelect, onClear, onSave, onDiscard, onRetry } = props
  const fieldId = useId()
  const locked = !state.available || !state.writable || state.saving
  return (
    <div className={styles['card']}>
      <h3 className={styles['title']}>{t('lightweightModel')}</h3>
      <p className={styles['hint']}>{t('lightweightModelHint')}</p>
      <div className={styles['field']}>
        <label className={styles['label']} htmlFor={fieldId}>{t('lightweightModel')}</label>
        <select
          id={fieldId}
          className={`${styles['input']} ${styles['selectInput']}`}
          disabled={locked}
          value={state.selected ?? ''}
          onChange={(event) => {
            const key = event.target.value
            if (key === '') onClear()
            else onSelect(key)
          }}
        >
          <option value="">{t('lightweightModelUnset')}</option>
          {state.candidates.map(candidate => (
            <option key={candidate.key} value={candidate.key}>
              {`${candidate.providerName} / ${candidate.modelName}`}
            </option>
          ))}
        </select>
      </div>
      {state.catalogStatus === 'loading' ? <p className={styles['status']}>{t('lightweightModelRetrying')}</p> : null}
      {state.catalogStatus === 'error'
        ? (
          <button type="button" className={styles['linkButton']} onClick={onRetry}>
            {t('retry')}
          </button>
        )
        : null}
      {state.catalogStatus === 'ready' && state.candidates.length === 0
        ? <p className={styles['status']}>{t('lightweightModelEmpty')}</p>
        : null}
      {!state.writable ? <p className={styles['notice']}>{t('lightweightModelReadOnly')}</p> : null}
      {state.failed ? <p className={styles['error']} role="alert">{t('lightweightModelFailed')}</p> : null}
      <div className={styles['actions']}>
        <Button variant="primary" disabled={locked || !state.dirty} onClick={onSave}>
          {state.saving ? t('lightweightModelSaving') : t('lightweightModelSave')}
        </Button>
        <Button variant="outline" disabled={state.saving || !state.dirty} onClick={onDiscard}>
          {t('lightweightModelDiscard')}
        </Button>
      </div>
    </div>
  )
}
