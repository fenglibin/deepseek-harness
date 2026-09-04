/**
 * Shared presentation constants for the delivery surface: the phase/label
 * tables and the artifact/gate derivations used by both the timeline card and
 * the floating card. Kept here so the two renderers agree on phase order and
 * label keys without duplicating the tier table.
 */

import type { DeliveryLevel, DeliveryPhase, DeliverySnapshot } from '@deepseek-ai/dsh-delivery/client'
import type { DeliveryKey } from './locales.ts'

/** Phase-label keys, one per lifecycle phase. */
export const PHASE_LABELS = {
  created: 'phase.created',
  designed: 'phase.designed',
  specified: 'phase.specified',
  implemented: 'phase.implemented',
  verified: 'phase.verified',
  accepted: 'phase.accepted',
} as const satisfies Record<DeliveryPhase, DeliveryKey>

/** Size-tier label keys. */
export const LEVEL_LABELS = {
  l0: 'level.l0',
  l1: 'level.l1',
  l2: 'level.l2',
} as const satisfies Record<DeliveryLevel, DeliveryKey>

/** The phases each size tier actually traverses. */
export const LEVEL_PHASES: Record<DeliveryLevel, readonly DeliveryPhase[]> = {
  l0: ['created', 'implemented', 'verified', 'accepted'],
  l1: ['created', 'designed', 'implemented', 'verified', 'accepted'],
  l2: ['created', 'designed', 'specified', 'implemented', 'verified', 'accepted'],
}

/** Derive the artifact paths a task's record counts imply (the record tools write these). */
export function deliveryArtifacts(task: DeliverySnapshot): readonly string[] {
  const artifacts: string[] = []
  if (task.changeCount > 0) artifacts.push(`.dsh/changes/${task.id}.md`)
  if (task.designCount > 0) artifacts.push(`.dsh/design/${task.id}.md`)
  if (task.specCount > 0) artifacts.push(`openspec/changes/${task.id}/spec.md`)
  return artifacts
}

/** The next gate prerequisite still unmet at the task's current phase. */
export function nextGate(task: DeliverySnapshot): DeliveryKey | undefined {
  const phases = LEVEL_PHASES[task.level]
  const next = phases[phases.indexOf(task.phase) + 1]
  if (next === 'implemented' && task.changeCount === 0) return 'gate.change'
  if (next === 'designed' && task.designCount === 0) return 'gate.design'
  if (next === 'specified' && task.specCount === 0) return 'gate.spec'
  return undefined
}
