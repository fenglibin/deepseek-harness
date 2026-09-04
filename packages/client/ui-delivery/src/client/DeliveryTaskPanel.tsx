/**
 * DeliveryTaskPanel: the keyed Chat renderer for one durable delivery task.
 * It shows the size-tier badge, the objective, a phase progress bar over the
 * tier's required phases, and the task's mutation timeline (create, advance,
 * and each change/design/spec record) — the §6.6 "Conversation node" surface.
 * Read-only: the task advances through the model-facing tools, never here.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DisclosureRow, IconChevronRightOutline14, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeliveryPhase } from '@deepseek-ai/dsh-delivery/client'
import { LEVEL_LABELS, LEVEL_PHASES, PHASE_LABELS } from './delivery-phases.ts'
import type { DeliveryTaskEvent } from './delivery-definition.ts'
import css from './DeliveryTaskPanel.module.css'

/** Full props of the keyed Chat renderer. */
export type DeliveryTaskPanelProps =
  PropsRuntime<'conversation.chat.node', 'delivery-task'>
  & PropsLocale<'delivery'>

/** Status dot for the task's current lifecycle position. */
function taskDotState(cleared: boolean, phase: DeliveryPhase): StateDotState {
  if (cleared) return 'warning'
  if (phase === 'accepted') return 'done'
  return 'ongoing'
}

/** Localized label for one timeline event. */
function eventLabel(event: DeliveryTaskEvent, t: DeliveryTaskPanelProps['t']): string {
  switch (event.operation) {
    case 'create': return t('event.create')
    case 'advance': return t('event.advance', { phase: t(PHASE_LABELS[event.phase as DeliveryPhase]) })
    case 'record-change': return t('event.record-change')
    case 'record-design': return t('event.record-design')
    case 'record-spec': return t('event.record-spec')
    case 'clear': return t('event.clear')
    /* v8 ignore next -- DeliveryOperation is closed and every variant is handled above. */
    default: return event.operation satisfies never
  }
}

/** Render one durable delivery task card. */
export function DeliveryTaskPanel({ node, t }: DeliveryTaskPanelProps) {
  const data = node.data
  const phases = LEVEL_PHASES[data.level]
  const currentIndex = phases.indexOf(data.phase)
  // An accepted or cleared task reads best collapsed; an in-flight one opens
  // so the reader sees the timeline without an extra click.
  const settled = data.phase === 'accepted' || data.cleared
  const [expanded, setExpanded] = useState(!settled)
  // The initial state covers first paint only. A live task that later reaches
  // accepted — or gets cleared — must re-settle the card, or an advancing task
  // would stay stuck in whatever posture it had when it was created.
  const settledRef = useRef(settled)
  useEffect(() => {
    if (settledRef.current === settled) return
    settledRef.current = settled
    setExpanded(!settled)
  }, [settled])
  const summary = useMemo(
    () => t('task.summary', {
      changeCount: data.changeCount,
      designCount: data.designCount,
      specCount: data.specCount,
    }),
    [data.changeCount, data.designCount, data.specCount, t],
  )
  return (
    <section
      className={css.root}
      data-delivery-task
      data-level={data.level}
      data-phase={data.phase}
      data-cleared={data.cleared || undefined}
    >
      <DisclosureRow
        rowClassName={css.header}
        leadingClassName={css.leading}
        titleClassName={css.title}
        icon={<StateDot state={taskDotState(data.cleared, data.phase)} />}
        title={data.objective}
        open={expanded}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.sep} aria-hidden />
            <span className={css.level} data-level={data.level}>{t(LEVEL_LABELS[data.level])}</span>
            <span className={css.summary}>{summary}</span>
          </>
        )}
      >
        <div className={css.body}>
          <div className={css.progress} data-testid="delivery-task-progress">
            {phases.map((phase, index) => {
              const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'
              return (
                <span key={phase} className={css.step} data-state={state} data-phase={phase}>
                  {t(PHASE_LABELS[phase])}
                </span>
              )
            })}
          </div>
          <ol className={css.timeline}>
            {data.events.map(event => (
              <li key={event.seq} className={css.event} data-operation={event.operation}>
                <span className={css.chevron} aria-hidden><IconChevronRightOutline14 /></span>
                <span className={css.eventLabel}>{eventLabel(event, t)}</span>
                {event.text !== undefined && <span className={css.eventText}>{event.text}</span>}
              </li>
            ))}
          </ol>
        </div>
      </DisclosureRow>
    </section>
  )
}
