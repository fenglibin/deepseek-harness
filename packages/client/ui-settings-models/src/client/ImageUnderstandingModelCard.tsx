/**
 * Image-understanding card: one vision route picked from the live model
 * catalog, or the explicit absence of one. The card owns no data — every fact
 * and action arrives through props, so a scope that refuses writes disables
 * the picker and says so rather than staging a choice it cannot save.
 */

import { useId } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageUnderstandingState } from './image-understanding-model-store.ts'
import type { zh } from './locales.ts'
import styles from './LightweightModelCard.module.css'

/** Props of {@link ImageUnderstandingModelCard}: one card state plus its actions. */
export interface ImageUnderstandingModelCardProps {
  /** Current card snapshot. */
  state: ImageUnderstandingState
  /** Models-page copy. */
  t: (key: keyof typeof zh) => string
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
 * Render the image-understanding picker.
 * @param props - card state and callbacks.
 * @returns the card.
 */
export function ImageUnderstandingModelCard(props: ImageUnderstandingModelCardProps): ReactNode {
  const { state, t, onSelect, onClear, onSave, onDiscard, onRetry } = props
  const fieldId = useId()
  const locked = !state.available || !state.writable || state.saving
  return (
    <div className={styles['card']}>
      <h3 className={styles['title']}>{t('imageUnderstanding')}</h3>
      <p className={styles['hint']}>{t('imageUnderstandingHint')}</p>
      <div className={styles['field']}>
        <label className={styles['label']} htmlFor={fieldId}>{t('imageUnderstanding')}</label>
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
          <option value="">{t('imageUnderstandingUnset')}</option>
          {state.candidates.map(candidate => (
            <option key={candidate.key} value={candidate.key}>
              {`${candidate.providerName} / ${candidate.modelName}`}
            </option>
          ))}
        </select>
      </div>
      {state.catalogStatus === 'loading' ? <p className={styles['status']}>{t('imageUnderstandingRetrying')}</p> : null}
      {state.catalogStatus === 'error'
        ? (
          <button type="button" className={styles['linkButton']} onClick={onRetry}>
            {t('retry')}
          </button>
        )
        : null}
      {state.catalogStatus === 'ready' && state.candidates.length === 0
        ? <p className={styles['status']}>{t('imageUnderstandingEmpty')}</p>
        : null}
      {!state.writable ? <p className={styles['notice']}>{t('imageUnderstandingReadOnly')}</p> : null}
      {state.failed ? <p className={styles['error']} role="alert">{t('imageUnderstandingFailed')}</p> : null}
      <div className={styles['actions']}>
        <Button variant="primary" disabled={locked || !state.dirty} onClick={onSave}>
          {state.saving ? t('imageUnderstandingSaving') : t('imageUnderstandingSave')}
        </Button>
        <Button variant="outline" disabled={state.saving || !state.dirty} onClick={onDiscard}>
          {t('imageUnderstandingDiscard')}
        </Button>
      </div>
    </div>
  )
}
