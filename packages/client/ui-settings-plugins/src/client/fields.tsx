/**
 * Hand-written controls for the plugin configuration forms. Each renders one
 * field's label, its staged text, whether saving would leave an override, and
 * — when one stands — the reset that stages a clear back to the composition
 * layer. Nothing here writes: a control reports what the user typed, and the
 * card's save is the single point where a draft becomes a document mutation.
 */

import { IconQuestionOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './fields.module.css'

/** What every field control needs regardless of its value type. */
export interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
  /**
   * Detailed explanation shown from the label's question mark. Omitted when a
   * field has nothing to add beyond its hint, which keeps the mark from
   * promising more than it delivers.
   */
  help?: string
}

/**
 * The label row shared by every control: the label, the question mark that
 * explains it, and — when one stands — the override badge and reset.
 *
 * The mark is a `<span>`, not a `<button>`: it is a hover affordance inside a
 * label, and a nested focusable control would put a second stop in the tab
 * order for a field the user is already on.
 * @param props - the field's copy, its help text, and its reset action.
 * @returns the label row.
 */
function FieldHead(props: Pick<FieldProps,
  'id' | 'label' | 'help' | 'overridden' | 'overriddenLabel' | 'resetLabel' | 'disabled' | 'onReset'>) {
  return (
    <div className={css.head}>
      <label className={css.label} htmlFor={props.id}>{props.label}</label>
      {props.help === undefined
        ? null
        : (
          <Tooltip label={props.help} side="top" maxWidth={320}>
            <span
              className={css.helpMark}
              data-testid={`field-help-${props.id}`}
              aria-label={props.help}
              role="img"
            >
              <IconQuestionOutline14 />
            </span>
          </Tooltip>
        )}
      {props.overridden
        ? (
          <span className={css.badges}>
            <span className={css.badge}>{props.overriddenLabel}</span>
            <button
              type="button"
              className={css.reset}
              disabled={props.disabled}
              onClick={props.onReset}
            >
              {props.resetLabel}
            </button>
          </span>
        )
        : null}
    </div>
  )
}

/**
 * A staged value field. `numeric` only hints the keypad: which drafts a field
 * accepts is decided by its spec, so the control never silently rewrites what
 * the user typed.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ValueField(props: FieldProps & {
  /** Hints a numeric keypad without narrowing what the control accepts. */
  numeric?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/**
 * A staged choice field: one option per accepted value, plus an empty entry
 * that clears the key back to the composition layer.
 *
 * The select writes the option value itself, so a draft can only ever be one
 * the field accepts — unlike a text input, where a typo reaches the spec and is
 * rejected there.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ChoiceField(props: FieldProps & {
  /** Accepted values, in the order the control offers them. */
  options: readonly string[]
  /** Label of the entry that clears the override. */
  clearLabel: string
}) {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <select
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      >
        <option value="">{props.clearLabel}</option>
        {props.options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/**
 * A staged list field: one entry per line.
 *
 * A textarea rather than a repeatable row editor, because the value is a plain
 * string list whose order is meaningful and whose entries are short; lines keep
 * both visible at once and make a whole-list replacement one gesture.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ListField(props: FieldProps & {
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <textarea
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        rows={4}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/**
 * A write-only credential control. The value never rides a response, so the
 * control reports only whether one is configured and starts blank; a blank
 * draft writes nothing, which keeps the stored key rather than clearing it.
 * @param props - the field's copy, its staged text, and the configured state.
 * @returns the labelled control.
 */
export function SecretField(props: Pick<FieldProps, 'id' | 'label' | 'hint' | 'text' | 'disabled' | 'onEdit' | 'help'> & {
  /** Whether the Host reports a configured credential for this reference. */
  configured: boolean
  /** Copy describing the configured state. */
  stateLabel: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.help === undefined
          ? null
          : (
            <Tooltip label={props.help} side="top" maxWidth={320}>
              <span
                className={css.helpMark}
                data-testid={`field-help-${props.id}`}
                aria-label={props.help}
                role="img"
              >
                <IconQuestionOutline14 />
              </span>
            </Tooltip>
          )}
        <span className={css.badges}>
          <span className={props.configured ? css.badge : css.badgeMuted}>{props.stateLabel}</span>
        </span>
      </div>
      <input
        id={props.id}
        className={css.input}
        type="password"
        autoComplete="off"
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
