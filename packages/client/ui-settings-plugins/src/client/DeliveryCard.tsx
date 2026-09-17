/** 交付纪律卡片：需求如何分级、以及每级要走过哪些门禁。 */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, IconChevronUpOutline14, IconCloseOutline16, IconQuestionOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { DeliveryHelp } from './DeliveryHelp.tsx'
import { ChoiceField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { DeliveryCardFace, DeliveryCardState } from './delivery-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './fields.module.css'

/** 卡片渲染器绑定的 props。 */
export type DeliveryCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<DeliveryCardFace>

/**
 * 渲染交付纪律卡片。
 * @param props - 文案、卡片快照与其表单动作。
 * @returns the card.
 */
export function DeliveryCard(props: DeliveryCardProps) {
  const { t } = props
  const state = props.useDeliveryCard(snapshot => snapshot)
  const [helpOpen, setHelpOpen] = useState(false)
  const disabled = !state.writable

  /** 卡片内每个控件都需要的公共文案。 */
  const shared = {
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    disabled,
  }

  /** 把一个字段的状态绑到它的编辑与重置动作上。 */
  const bind = (field: string, value: typeof state.enforcement) => ({
    ...shared,
    ...value,
    onEdit: (text: string) => { props.edit(field, text) },
    onReset: () => { props.resetField(field) },
  })

  return (
    <>
      <PluginCard
        t={t}
        titleKey="deliveryTitle"
        descriptionKey="deliveryDescription"
        state={state}
        onSave={props.save}
        onDiscard={props.discard}
        onHelp={() => { setHelpOpen(true) }}
      >
        {/* 本卡片字段多且各自较短，按两列排布；多行控件在字段样式中声明独占整行。
            其它卡片的字段数量少，保持各自的纵向布局。 */}
        <div className={css.grid}>
          <ChoiceField
            id="plugin-config-delivery-enforcement"
            label={t('deliveryEnforcement')}
            help={t('deliveryHelpEnforcement')}
            hint={t('deliveryEnforcementHint')}
            invalidLabel={t('invalidEnum')}
            clearLabel={t('useDefault')}
            options={['stateful', 'advisory', 'off']}
            {...bind('enforcement', state.enforcement)}
          />
          <ChoiceField
            id="plugin-config-delivery-enabled"
            label={t('deliveryEnabled')}
            help={t('deliveryHelpEnabled')}
            hint={t('deliveryEnabledHint')}
            invalidLabel={t('invalidBoolean')}
            clearLabel={t('useDefault')}
            options={['true', 'false']}
            {...bind('enabled', state.enabled)}
          />
          <ChoiceField
            id="plugin-config-delivery-auto-detect"
            label={t('deliveryAutoDetect')}
            help={t('deliveryHelpAutoDetect')}
            hint={t('deliveryAutoDetectHint')}
            invalidLabel={t('invalidBoolean')}
            clearLabel={t('useDefault')}
            options={['true', 'false']}
            {...bind('autoDetect', state.autoDetect)}
          />
          <ChoiceField
            id="plugin-config-delivery-bugs"
            label={t('deliveryRequireOpenspecForBugs')}
            help={t('deliveryHelpRequireOpenspecForBugs')}
            hint={t('deliveryRequireOpenspecForBugsHint')}
            invalidLabel={t('invalidBoolean')}
            clearLabel={t('useDefault')}
            options={['true', 'false']}
            {...bind('requireOpenspecForBugs', state.requireOpenspecForBugs)}
          />
          <ValueField
            id="plugin-config-delivery-review-rounds"
            label={t('deliveryMaxReviewRounds')}
            help={t('deliveryHelpMaxReviewRounds')}
            hint={t('deliveryMaxReviewRoundsHint')}
            invalidLabel={t('invalidNumber')}
            numeric
            {...bind('maxReviewRounds', state.maxReviewRounds)}
          />
          <ValueField
            id="plugin-config-delivery-design-todos"
            label={t('deliveryDesignTodoCount')}
            help={t('deliveryHelpDesignTodoCount')}
            hint={t('deliveryDesignTodoCountHint')}
            invalidLabel={t('invalidNumber')}
            numeric
            {...bind('designThreshold.todoCount', state.designTodoCount)}
          />
          <ValueField
            id="plugin-config-delivery-design-files"
            label={t('deliveryDesignFiles')}
            help={t('deliveryHelpDesignFiles')}
            hint={t('deliveryDesignFilesHint')}
            invalidLabel={t('invalidNumber')}
            numeric
            {...bind('designThreshold.touchedFiles', state.designFiles)}
          />
          <ValueField
            id="plugin-config-delivery-spec-todos"
            label={t('deliverySpecTodoCount')}
            help={t('deliveryHelpSpecTodoCount')}
            hint={t('deliverySpecTodoCountHint')}
            invalidLabel={t('invalidNumber')}
            numeric
            {...bind('openspecThreshold.todoCount', state.specTodoCount)}
          />
          <ValueField
            id="plugin-config-delivery-spec-chars"
            label={t('deliverySpecChars')}
            help={t('deliveryHelpSpecChars')}
            hint={t('deliverySpecCharsHint')}
            invalidLabel={t('invalidNumber')}
            numeric
            {...bind('openspecThreshold.descriptionChars', state.specChars)}
          />
          <ValueField
            id="plugin-config-delivery-grading-prompt"
            label={t('deliveryGradingPrompt')}
            help={t('deliveryHelpGradingPrompt')}
            hint={t('deliveryGradingPromptHint')}
            invalidLabel={t('invalidNumber')}
            textarea
            {...bind('gradingPrompt', state.gradingPrompt)}
          />
          <VerificationCommands
            t={t}
            state={state}
            disabled={disabled}
            onToggle={props.toggleVerificationCommand}
            onMove={props.moveVerificationCommand}
            onReset={() => { props.resetField('verificationCommands') }}
          />
        </div>
      </PluginCard>
      <DeliveryHelp open={helpOpen} onClose={() => { setHelpOpen(false) }} t={t} />
    </>
  )
}

/**
 * 验收命令选择器：上方是已选命令的执行顺序，下方是候选命令的勾选清单。
 *
 * 它不收集自由文本：验收要由模型执行一段提示词，而普通用户并不掌握可以填什么
 * 命令，因此候选来自用户已经维护好的那份清单。顺序有实际语义——门禁要求模型
 * 从第一条开始依次留下验收记录——所以已选区是一个可见顺序的列表，勾选只负责
 * 追加到末尾，调整顺序走拖动或每行的上移/下移按钮。键盘用户因此不需要模拟拖动。
 *
 * 已选但当前不再提供的名字仍然渲染在已选区，以便用户看见并移除它，而不是让它
 * 悄悄留在下一次保存里。
 * @param props - 文案、卡片快照、禁用态、切换与移动动作、重置动作。
 * @returns the labelled command picker.
 */
function VerificationCommands(props: {
  t: DeliveryCardProps['t']
  state: DeliveryCardState
  disabled: boolean
  onToggle: (name: string) => void
  onMove: (name: string, to: number) => void
  onReset: () => void
}) {
  const { t, state } = props
  // 拖动中被拖动的条目名；null 表示没有拖动在进行。
  const [dragging, setDragging] = useState<string | null>(null)
  // 当前悬停的目标下标；null 表示指针不在任何条目上。
  const [dropAt, setDropAt] = useState<number | null>(null)
  const selected = state.verificationSelected
  const missing = state.verificationMissing
  const candidates = state.verificationCandidates
  const empty = selected.length === 0 && candidates.length === 0
  const commandTitle = (name: string): string | undefined => {
    for (const command of state.verificationCandidates) {
      if (command.name === name) return command.title
    }
    return undefined
  }
  /** 键盘可达的排序：拖动与按钮共用控制器里的同一个移动动作。 */
  const move = (name: string, delta: number): void => {
    props.onMove(name, selected.indexOf(name) + delta)
  }
  return (
    <div className={`${css.field} ${css.wide}`}>
      <div className={css.head}>
        <span className={css.label} id="plugin-config-delivery-verification-label">
          {t('deliveryVerificationCommands')}
        </span>
        <Tooltip label={t('deliveryHelpVerificationCommands')} side="top" maxWidth={320}>
          <span
            className={css.helpMark}
            data-testid="field-help-plugin-config-delivery-verification"
            aria-label={t('deliveryHelpVerificationCommands')}
            role="img"
          >
            <IconQuestionOutline14 />
          </span>
        </Tooltip>
        {state.verificationCommands.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{t('overridden')}</span>
              <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
                {t('reset')}
              </button>
            </span>
          )
          : null}
      </div>
      {empty
        ? <p className={css.hint}>{t('deliveryVerificationEmpty')}</p>
        : (
          <>
            {selected.length === 0
              ? <p className={css.hint}>{t('deliveryVerificationSelectedEmpty')}</p>
              : (
                <ol
                  className={css.ordered}
                  data-testid="delivery-verification-selected"
                  aria-labelledby="plugin-config-delivery-verification-label"
                >
                  {selected.map((name, index) => {
                    const gone = missing.includes(name)
                    return (
                      <li
                        key={name}
                        className={`${css.orderedRow} ${dropAt === index && dragging !== null ? css.orderedDrop : ''}`}
                        draggable={!props.disabled}
                        onDragStart={(event) => {
                          setDragging(name)
                          event.dataTransfer.effectAllowed = 'move'
                          // 拖动载荷仅为兼容浏览器要求；真正的来源是组件状态。
                          event.dataTransfer.setData('text/plain', name)
                        }}
                        onDragEnd={() => { setDragging(null); setDropAt(null) }}
                        onDragOver={(event) => {
                          if (dragging === null) return
                          event.preventDefault()
                          event.dataTransfer.dropEffect = 'move'
                          setDropAt(index)
                        }}
                        onDrop={(event) => {
                          if (dragging === null) return
                          event.preventDefault()
                          props.onMove(dragging, index)
                          setDragging(null)
                          setDropAt(null)
                        }}
                      >
                        <span
                          className={css.dragHandle}
                          aria-hidden="true"
                          title={t('deliveryVerificationDragHandle')}
                        >
                          ⠿
                        </span>
                        <span className={css.orderIndex}>{index + 1}</span>
                        <span className={css.orderedBody}>
                          <span className={css.choiceName}>{`/${name}`}</span>
                          {gone
                            ? <span className={css.choiceTitle}>{t('deliveryVerificationMissing')}</span>
                            : commandTitle(name) === undefined || commandTitle(name) === ''
                              ? null
                              : <span className={css.choiceTitle}>{commandTitle(name)}</span>}
                        </span>
                        <span className={css.rowActions}>
                          <button
                            type="button"
                            className={css.iconButton}
                            disabled={props.disabled || index === 0}
                            aria-label={`${t('deliveryVerificationMoveUp')}: /${name}`}
                            onClick={() => { move(name, -1) }}
                          >
                            <IconChevronUpOutline14 />
                          </button>
                          <button
                            type="button"
                            className={css.iconButton}
                            disabled={props.disabled || index === selected.length - 1}
                            aria-label={`${t('deliveryVerificationMoveDown')}: /${name}`}
                            onClick={() => { move(name, 1) }}
                          >
                            <IconChevronDownOutline14 />
                          </button>
                          <button
                            type="button"
                            className={css.iconButton}
                            disabled={props.disabled}
                            aria-label={`${t('deliveryVerificationRemove')}: /${name}`}
                            onClick={() => { props.onToggle(name) }}
                          >
                            <IconCloseOutline16 />
                          </button>
                        </span>
                      </li>
                    )
                  })}
                </ol>
              )}
            {candidates.length === 0 ? null : (
              <>
                <p className={css.groupLabel}>{t('deliveryVerificationCandidates')}</p>
                <div
                  className={css.choices}
                  role="group"
                  aria-label={t('deliveryVerificationCandidates')}
                >
                  {candidates.map(command => (
                    <label key={command.name} className={css.choice}>
                      <input
                        type="checkbox"
                        className={css.checkbox}
                        checked={false}
                        disabled={props.disabled}
                        onChange={() => {
                          // 勾选即追加到末尾：不重排用户已经排好的顺序。
                          props.onToggle(command.name)
                        }}
                      />
                      <span>
                        <span className={css.choiceName}>{`/${command.name}`}</span>
                        {command.title === undefined || command.title === ''
                          ? null
                          : <span className={css.choiceTitle}>{command.title}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      <p className={css.hint}>{t('deliveryVerificationCommandsHint')}</p>
    </div>
  )
}
