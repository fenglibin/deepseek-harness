/**
 * DeliveryFloatCard: the floating task card pinned to the conversation body's
 * left edge (§6.6 "会话侧边栏/卡片"). It reads the host-computed `delivery`
 * projection and shows the current task's tier badge, phase, and objective in
 * a compact card; expanding reveals the phase progress bar and artifact paths.
 * Read-only: the task advances through the model-facing tools, never here.
 */

import { useEffect, useRef, useState } from 'react'
import {
  IconChevronDownOutline14, IconChevronUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { deliveryArtifacts, LEVEL_LABELS, LEVEL_PHASES, nextGate, PHASE_LABELS } from './delivery-phases.ts'
import css from './DeliveryFloatCard.module.css'

/** Full props of the floating-card entry. */
export type DeliveryFloatCardProps =
  PropsRuntime<'conversation.side.float'> & PropsLocale<'delivery'>

/** Render the current task as a floating card pinned to the body's left edge. */
export function DeliveryFloatCard({ useProjection, t }: DeliveryFloatCardProps) {
  const projection = useProjection('delivery')
  const checklist = useProjection('delivery-tasks')
  const [expanded, setExpanded] = useState(false)
  // A task that reaches a new phase opens itself, so the checklist for the
  // phase now in progress is visible without an extra click.
  const phase = projection?.task.phase
  const phaseRef = useRef(phase)
  useEffect(() => {
    if (phase === undefined || phaseRef.current === phase) return
    phaseRef.current = phase
    setExpanded(true)
  }, [phase])
  if (projection === undefined || projection === null) return null
  const task = projection.task
  const phases = LEVEL_PHASES[task.level]
  const currentIndex = phases.indexOf(task.phase)
  const artifacts = deliveryArtifacts(task, checklist?.changeId)
  const gate = nextGate(task)
  const progress = checklist === undefined || checklist === null ? undefined : checklist.progress
  return (
    <section className={css.root} data-delivery-float data-level={task.level} data-phase={task.phase}>
      <button
        type="button"
        className={css.card}
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.level} data-level={task.level}>{t(LEVEL_LABELS[task.level])}</span>
        <span className={css.phase}>{t(PHASE_LABELS[task.phase])}</span>
        <span className={css.objective}>{task.objective}</span>
        <span className={css.chevron} aria-hidden>
          {expanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
        </span>
      </button>
      {expanded && (
        <div className={css.panel}>
          <div className={css.progress} data-testid="delivery-float-progress">
            {phases.map((phase, index) => {
              const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'
              const counts = progress?.[phase]
              return (
                <span key={phase} className={css.step} data-state={state} data-phase={phase}>
                  {t(PHASE_LABELS[phase])}
                  {counts !== undefined && counts.total > 0 && (
                    <span className={css.stepCounts} data-testid={`delivery-float-counts-${phase}`}>
                      {t('progress.counts', { done: counts.done, total: counts.total })}
                    </span>
                  )}
                </span>
              )
            })}
          </div>
          {gate !== undefined && <span className={css.gate}>{t(gate)}</span>}
          {artifacts.length > 0 && (
            <ul className={css.artifacts}>
              {artifacts.map(path => <li key={path} className={css.artifactPath}>{path}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
