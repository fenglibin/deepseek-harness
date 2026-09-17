/**
 * Hand-written controls for the plugin configuration forms. Each renders one
 * field's label, its staged text, whether saving would leave an override, and
 * — when one stands — the reset that stages a clear back to the composition
 * layer. Nothing here writes: a control reports what the user typed, and the
 * card's save is the single point where a draft becomes a document mutation.
 */

import { useState } from 'react'
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
  /** Renders a multi-line control and spans the whole grid row. */
  textarea?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  // Prose values need a multi-line control and the full row: a one-line input
  // would hide most of the text and make editing a prompt impractical.
  const multiline = props.textarea === true
  return (
    <div className={multiline ? `${css.field} ${css.wide}` : css.field}>
      <FieldHead {...props} />
      {multiline
        ? (
          <textarea
            id={props.id}
            className={props.invalid ? css.textareaInvalid : css.textarea}
            rows={8}
            {...props.invalid ? { 'aria-invalid': true } : {}}
            value={props.text}
            placeholder={props.placeholder ?? ''}
            disabled={props.disabled}
            onChange={(event) => { props.onEdit(event.target.value) }}
          />
        )
        : (
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
        )}
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
 * 以「一个值一个可删除标签」的方式编辑的列表字段。
 *
 * 每个值都是独立控件，因此增删改一条都不必去编辑一整块共享文本——多行文本格式
 * 要求用户自己知道「换行即分隔」。待添加的输入与正在改的那一条都是组件局部状态，
 * 因为它们在提交前不属于字段值：半途输入的内容若进入草稿，保存就会写入用户并未
 * 写完的片段。提交时暂存整份列表，从而保持表单「只在保存时写入一次」的契约。
 *
 * 改一条走行内编辑而不是「先删再加」：两步操作会让列表在中间态里少一条，而这一
 * 步只是改一个词。
 * @param props - 字段文案、其暂存文本与编辑动作。
 * @returns 带标签的标签编辑器。
 */
export function TagField(props: FieldProps & {
  /** 条目输入框的占位文本。 */
  placeholder?: string
  /** 提交待添加条目的控件文案。 */
  addLabel: string
  /** 单个标签的移除控件文案。 */
  removeLabel: string
  /** 点击标签文字进入改写时的无障碍文案。 */
  editLabel: string
  /** 待添加条目无法提交时显示的文案。 */
  duplicateLabel: string
}) {
  const [pending, setPending] = useState('')
  /** 正在改写的那一条：原下标与草稿；null 表示没有在改。 */
  const [editing, setEditing] = useState<{ index: number; draft: string } | null>(null)
  const entries = props.text.split('\n').filter(entry => entry.length > 0)
  const trimmed = pending.trim()
  const duplicate = trimmed !== '' && entries.includes(trimmed)
  const committable = trimmed !== '' && !duplicate && !props.disabled
  /** 提交整份列表，使暂存草稿始终只包含完整条目。 */
  const commit = (next: readonly string[]): void => {
    props.onEdit(next.join('\n'))
  }
  const add = (): void => {
    if (!committable) return
    commit([...entries, trimmed])
    setPending('')
  }
  /**
   * 提交一条改写。空值与重名都不写入，因此草稿里不会出现空条目或重复条目；
   * 调用方据此决定是留在编辑态还是退出。
   * @param index - 被改写的条目下标。
   * @param next - 用户输入的文本。
   * @returns 是否已写入。
   */
  const rename = (index: number, next: string): boolean => {
    const value = next.trim()
    if (value === '' || value === entries[index]) return value === entries[index]
    if (entries.some((entry, at) => at !== index && entry === value)) return false
    commit(entries.map((entry, at) => at === index ? value : entry))
    return true
  }
  return (
    <div className={`${css.field} ${css.wide}`}>
      <FieldHead {...props} />
      <div className={css.tags}>
        {entries.map((entry, index) => (
          editing?.index === index
            ? (
              <span key={entry} className={`${css.tag} ${css.tagEditing}`}>
                <input
                  className={css.tagEditInput}
                  type="text"
                  value={editing.draft}
                  // 按内容估宽：`size` 以字符计，主流浏览器都遵守；只靠 CSS 的
                  // `field-sizing` 在 Safari/Firefox 下会退回默认宽度。
                  size={Math.min(46, Math.max(4, editing.draft.length || entry.length))}
                  aria-label={`${props.editLabel}: ${entry}`}
                  autoFocus
                  onChange={(event) => { setEditing({ index, draft: event.target.value }) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditing(null)
                      return
                    }
                    if (event.key !== 'Enter') return
                    // 回车提交改写，而不是提交卡片表单。
                    event.preventDefault()
                    if (rename(index, editing.draft)) setEditing(null)
                  }}
                  onBlur={() => {
                    // 失焦时提交合法改动，非法改动按放弃处理：留在编辑态会让焦点
                    // 已经离开的输入框继续拦着后续操作。
                    rename(index, editing.draft)
                    setEditing(null)
                  }}
                />
              </span>
            )
            : (
              <span key={entry} className={css.tag}>
                <button
                  type="button"
                  className={css.tagText}
                  disabled={props.disabled}
                  aria-label={`${props.editLabel}: ${entry}`}
                  onClick={() => { setEditing({ index, draft: entry }) }}
                >
                  {entry}
                </button>
                <button
                  type="button"
                  className={css.tagRemove}
                  disabled={props.disabled}
                  aria-label={`${props.removeLabel}: ${entry}`}
                  onClick={() => { commit(entries.filter(candidate => candidate !== entry)) }}
                >
                  ×
                </button>
              </span>
            )
        ))}
      </div>
      <div className={css.tagEntry}>
        <input
          id={props.id}
          className={css.input}
          type="text"
          value={pending}
          placeholder={props.placeholder ?? ''}
          disabled={props.disabled}
          onChange={(event) => { setPending(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            // 回车用于提交条目，而不是提交卡片表单。
            event.preventDefault()
            add()
          }}
        />
        <button type="button" className={css.tagAdd} disabled={!committable} onClick={add}>
          {props.addLabel}
        </button>
      </div>
      <p className={duplicate ? css.invalid : css.hint}>
        {duplicate ? props.duplicateLabel : props.hint}
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
