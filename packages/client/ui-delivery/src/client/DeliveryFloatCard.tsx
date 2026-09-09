/**
 * DeliveryFloatCard: the floating task card pinned to the conversation body's
 * left edge (§6.6 "会话侧边栏/卡片"). It reads the host-computed `delivery`
 * and `delivery-tasks` projections and renders the current task's semantic
 * progress in four groups — requirement analysis, design, task list, and
 * implementation verification — each with a live status. Expanded by default
 * so the user sees the whole-task state at a glance.
 * Read-only: the task advances through the model-facing tools, never here.
 */

import { useState } from 'react'
import {
  IconChevronDownOutline14, IconChevronUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeliveryPhase, DeliveryTaskStatus } from '@deepseek-ai/dsh-delivery/client'
import { LEVEL_LABELS } from './delivery-phases.ts'
import css from './DeliveryFloatCard.module.css'

/** Full props of the floating-card entry. */
export type DeliveryFloatCardProps =
  PropsRuntime<'conversation.side.float'> & PropsLocale<'delivery'>

/** Progress state of one semantic group. */
type GroupState = 'todo' | 'doing' | 'writing' | 'done'

/** Localized text for one group state. */
function stateText(state: GroupState, t: DeliveryFloatCardProps['t']): string {
  switch (state) {
    case 'todo': return t('status.todo')
    case 'doing': return t('status.doing')
    case 'writing': return t('status.writing')
    case 'done': return t('status.done')
  }
}

/** Localized text for one checklist item status. */
function itemStateText(status: DeliveryTaskStatus, t: DeliveryFloatCardProps['t']): string {
  switch (status) {
    case 'pending': return t('status.todo')
    case 'in_progress': return t('status.doing')
    case 'completed': return t('status.done')
  }
}

/** Verification group state derived from the task phase. */
function verifyState(phase: DeliveryPhase): GroupState {
  if (phase === 'implemented') return 'doing'
  if (phase === 'verified' || phase === 'accepted') return 'done'
  return 'todo'
}

/** Render the current task as a floating card pinned to the body's left edge. */
export function DeliveryFloatCard({ useProjection, t }: DeliveryFloatCardProps) {
  const projection = useProjection('delivery')
  const checklist = useProjection('delivery-tasks')
  const [expanded, setExpanded] = useState(true)
  if (projection === undefined || projection === null) return null
  const task = projection.task
  const items = checklist === undefined || checklist === null ? [] : checklist.items
  const analysis: GroupState = task.analysisDone ? 'done' : 'doing'
  const design: GroupState = task.designCount > 0 ? 'done' : 'writing'
  const verify = verifyState(task.phase)

  return (
    <section className={css.root} data-delivery-float data-level={task.level} data-phase={task.phase}>
      <button
        type="button"
        className={css.card}
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.level} data-level={task.level}>{t(LEVEL_LABELS[task.level])}</span>
        <span className={css.objective}>{task.objective}</span>
        <span className={css.chevron} aria-hidden>
          {expanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
        </span>
      </button>
      {expanded && (
        <div className={css.panel} data-testid="delivery-float-progress">
          <div className={css.group} data-group="analysis" data-state={analysis}>
            <span className={css.groupLabel}>{t('progress.analysis')}</span>
            <span className={css.groupState}>{stateText(analysis, t)}</span>
          </div>
          {task.level !== 'l0' && (
            <div className={css.group} data-group="design" data-state={design}>
              <span className={css.groupLabel}>{t('progress.design')}</span>
              <span className={css.groupState}>{stateText(design, t)}</span>
            </div>
          )}
          <div className={css.group} data-group="tasks">
            <span className={css.groupLabel}>{t('progress.tasks')}</span>
            {items.length === 0
              ? <span className={css.groupState}>{t('progress.tasks.none')}</span>
              : (
                <ol className={css.taskList}>
                  {items.map(item => (
                    <li key={item.content} className={css.taskItem} data-status={item.status}>
                      <span className={css.taskContent}>{item.content}</span>
                      <span className={css.taskState}>{itemStateText(item.status, t)}</span>
                    </li>
                  ))}
                </ol>
              )}
          </div>
          <div className={css.group} data-group="verify" data-state={verify}>
            <span className={css.groupLabel}>{t('progress.verify')}</span>
            <span className={css.groupState}>{stateText(verify, t)}</span>
          </div>
        </div>
      )}
    </section>
  )
}
