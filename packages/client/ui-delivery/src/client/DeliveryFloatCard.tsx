/**
 * DeliveryFloatCard: the floating task card pinned to the conversation body's
 * left edge (§6.6 "会话侧边栏/卡片"). It reads the host-computed `delivery`,
 * `delivery-tasks`, and `todos` projections and renders the current task's
 * semantic progress in four groups — requirement analysis, design, task list,
 * and implementation verification — each with a live status.
 *
 * Hidden by default: the card overlays the transcript, and its progress can
 * disagree with what the reader sees the agent doing, so it stays out of the
 * way until Ctrl+Shift+P asks for it. The preference persists across reloads.
 * The design group's completed status carries an openable link to the design
 * document, so a reader reaches the file from the card itself.
 * Read-only: the task advances through the model-facing tools, never here.
 */

import { useEffect, useState } from 'react'
import {
  IconChevronDownOutline14, IconChevronUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeliveryPhase, DeliveryTaskStatus } from '@deepseek-ai/dsh-delivery/client'
import { designArtifact, LEVEL_LABELS, LEVEL_PHASES, PHASE_LABELS } from './delivery-phases.ts'
import { cardVisible, type createDeliveryCardStore } from './visibility-store.ts'
import css from './DeliveryFloatCard.module.css'

/** Business callbacks and hooks the plugin injects into the floating card. */
export interface DeliveryFloatCardInjected {
  /** Hand one workspace-relative path to the Host desktop opener. */
  openFile: (path: string) => Promise<void>
}

/** Full props of the floating-card entry. */
export type DeliveryFloatCardProps =
  PropsRuntime<'conversation.side.float'>
  & PropsStore<ReturnType<typeof createDeliveryCardStore>>
  & DeliveryFloatCardInjected
  & PropsLocale<'delivery'>

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

/** Whether a keyboard event is the card's Ctrl+Shift+P visibility toggle. */
function isToggleShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p'
}

/** Render the current task as a floating card pinned to the body's left edge. */
export function DeliveryFloatCard({
  useProjection, useStore, actions, openFile, t,
}: DeliveryFloatCardProps) {
  const projection = useProjection('delivery')
  const checklist = useProjection('delivery-tasks')
  const preference = useStore(state => state.preference)
  const [expanded, setExpanded] = useState(true)
  const [openError, setOpenError] = useState<string | null>(null)

  // The listener rides the always-mounted component rather than a global
  // keyboard service: the card owns the only binding, and unloading the
  // plugin fiber releases it with the effect.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isToggleShortcut(event)) return
      event.preventDefault()
      actions.cycle()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [actions])

  // The card follows the task by default, so a reader sees progress without
  // discovering the shortcut; an explicit preference overrides that both ways.
  const hasTask = projection !== undefined && projection !== null
  if (!cardVisible(preference, hasTask)) return null
  if (projection === undefined || projection === null) return null
  const task = projection.task
  // `delivery-tasks` is the single authority for the checklist: an l1 task's
  // todo list is mirrored into it by the host fold, and an l2 task records one
  // directly. Reading the todo projection here as a second source made the
  // card freeze on whichever list was written first.
  const items = checklist === undefined || checklist === null ? [] : checklist.items
  const source = checklist === undefined || checklist === null ? undefined : checklist.source
  // Grouping by phase is what makes the checklist readable: a flat list of a
  // long plan hides which stage of the work is actually behind. Phases with no
  // items are dropped, so the card shows only stages that carry work.
  const progress = checklist === undefined || checklist === null ? undefined : checklist.progress
  const phaseGroups = progress === undefined
    ? []
    : LEVEL_PHASES[task.level]
      .filter(phase => (progress[phase]?.total ?? 0) > 0)
      .map(phase => ({
        phase,
        progress: progress[phase] ?? { done: 0, total: 0 },
        items: items.filter(item => item.phase === phase),
      }))
  const analysis: GroupState = task.analysisDone ? 'done' : 'doing'
  const design: GroupState = task.designCount > 0 ? 'done' : 'writing'
  const verify = verifyState(task.phase)
  const designPath = designArtifact(task)
  const openDesign = (path: string): void => {
    void openFile(path).then(
      () => { setOpenError(null) },
      (error: unknown) => {
        setOpenError(t('progress.design.openFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }))
      },
    )
  }

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
              {design === 'done' && designPath !== undefined && (
                <button
                  type="button"
                  className={css.designLink}
                  title={designPath}
                  aria-label={t('progress.design.open', { path: designPath })}
                  onClick={() => { openDesign(designPath) }}
                >
                  {designPath}
                </button>
              )}
            </div>
          )}
          <div className={css.group} data-group="tasks">
            <div className={css.groupHead}>
              <span className={css.groupLabel}>{t('progress.tasks')}</span>
              {items.length === 0 && (
                <span className={css.groupState}>{t('progress.tasks.none')}</span>
              )}
              {source !== undefined && items.length > 0 && (
                <span className={css.groupState} data-source={source}>
                  {t(source === 'mirrored' ? 'progress.tasks.source.todo' : 'progress.tasks.source.recorded')}
                </span>
              )}
            </div>
            {phaseGroups.map(group => (
              <div key={group.phase} className={css.phaseGroup} data-phase={group.phase}>
                <div className={css.phaseHead}>
                  <span className={css.phaseLabel}>{t(PHASE_LABELS[group.phase])}</span>
                  <span className={css.phaseCounts}>
                    {t('progress.counts', { done: group.progress.done, total: group.progress.total })}
                  </span>
                </div>
                <ol className={css.taskList}>
                  {group.items.map(item => (
                    <li key={item.content} className={css.taskItem} data-status={item.status}>
                      <span className={css.taskContent}>{item.content}</span>
                      <span className={css.taskState}>{itemStateText(item.status, t)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
          <div className={css.group} data-group="verify" data-state={verify}>
            <span className={css.groupLabel}>{t('progress.verify')}</span>
            <span className={css.groupState}>{stateText(verify, t)}</span>
          </div>
          {openError !== null && (
            <div className={css.openError} role="status">{openError}</div>
          )}
        </div>
      )}
    </section>
  )
}
