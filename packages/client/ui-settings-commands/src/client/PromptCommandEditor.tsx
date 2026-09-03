/**
 * Add/edit form for one prompt command. A draft is staged locally and saved
 * only when the user confirms, so nothing writes while they type. The save is
 * blocked until the draft normalizes to a valid entry (name, description, and
 * prompt text are all non-empty).
 */

import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptCommandEntry } from './controller.ts'
import { normalizeDraft } from './controller.ts'
import type { PromptCommandKey } from './locales.ts'
import css from './PromptCommandEditor.module.css'

export interface PromptCommandEditorProps {
  open: boolean
  /** Editor heading: add vs. edit. */
  title: string
  /** The staged draft. */
  draft: PromptCommandEntry
  /** Localized copy reader. */
  t: (key: PromptCommandKey) => string
  /** Replace the staged draft. */
  onDraftChange: (draft: PromptCommandEntry) => void
  onCancel: () => void
  onSave: () => void
}

/** One labelled form field over the staged draft. */
function Field(props: {
  id: string
  label: string
  optional?: boolean
  optionalLabel?: string
  value: string
  placeholder?: string
  textarea?: boolean
  onChange: (value: string) => void
}) {
  const optional = props.optional === true && props.optionalLabel !== undefined
    ? <span className={css.optional}>{props.optionalLabel}</span>
    : null
  return (
    <label className={css.field} htmlFor={props.id}>
      <span className={css.label}>{props.label}{optional}</span>
      {props.textarea === true
        ? (
          <textarea
            id={props.id}
            className={css.textarea}
            value={props.value}
            placeholder={props.placeholder ?? ''}
            onChange={(event) => { props.onChange(event.currentTarget.value) }}
          />
        )
        : (
          <Input
            id={props.id}
            value={props.value}
            placeholder={props.placeholder ?? ''}
            onChange={(event) => { props.onChange(event.currentTarget.value) }}
          />
        )}
    </label>
  )
}

/**
 * Render the prompt-command editor modal.
 * @param props - the staged draft and the save/cancel actions.
 * @returns the modal while open, null otherwise.
 */
export function PromptCommandEditor(props: PromptCommandEditorProps) {
  const { open, title, draft, t } = props
  const valid = normalizeDraft(draft) !== undefined
  const set = (patch: Partial<PromptCommandEntry>): void => {
    props.onDraftChange({ ...draft, ...patch })
  }
  return (
    <Modal
      open={open}
      onClose={props.onCancel}
      title={title}
      closeLabel={t('cancel')}
      contentClassName={css.content ?? ''}
      footer={(
        <>
          <Button variant="outline" onClick={props.onCancel}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!valid} onClick={props.onSave}>{t('save')}</Button>
        </>
      )}
    >
      <Field
        id="prompt-command-name"
        label={t('fieldName')}
        value={draft.name}
        placeholder="code-review"
        onChange={(value) => { set({ name: value }) }}
      />
      <Field
        id="prompt-command-title"
        label={t('fieldTitle')}
        optional
        optionalLabel={t('titleOptional')}
        value={draft.title ?? ''}
        placeholder={t('fieldTitle')}
        onChange={(value) => { set({ title: value }) }}
      />
      <Field
        id="prompt-command-description"
        label={t('fieldDescription')}
        value={draft.description}
        placeholder={t('fieldDescription')}
        onChange={(value) => { set({ description: value }) }}
      />
      <Field
        id="prompt-command-prompt"
        label={t('fieldPrompt')}
        value={draft.prompt}
        placeholder={t('fieldPrompt')}
        textarea
        onChange={(value) => { set({ prompt: value }) }}
      />
      <Field
        id="prompt-command-hint"
        label={t('fieldHint')}
        optional
        optionalLabel={t('hintOptional')}
        value={draft.hint ?? ''}
        placeholder={t('fieldHint')}
        onChange={(value) => { set({ hint: value }) }}
      />
      {!valid ? <p className={css.invalid} role="status">{t('invalid')}</p> : null}
    </Modal>
  )
}
