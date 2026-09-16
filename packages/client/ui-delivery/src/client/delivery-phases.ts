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

/**
 * The phases each size tier actually traverses.
 *
 * A local copy rather than an import: the `@deepseek-ai/dsh-delivery/client`
 * entry is a pure type outlet with no runtime exports, so the host table
 * cannot be reached from the browser half. `delivery-phases.client.spec.ts`
 * asserts this copy equals the host's `LEVEL_PHASES`, so the two cannot drift
 * silently.
 */
export const LEVEL_PHASES: Record<DeliveryLevel, readonly DeliveryPhase[]> = {
  l0: ['created', 'implemented', 'verified', 'accepted'],
  l1: ['created', 'designed', 'implemented', 'verified', 'accepted'],
  l2: ['created', 'designed', 'specified', 'implemented', 'verified', 'accepted'],
}

/**
 * Derive the design document path a task's design records were appended to.
 * Separate from {@link deliveryArtifacts} because a reader opens the design
 * document by name, while the artifact list is an unordered inventory.
 * @param task - current task snapshot.
 * @returns the design record path, or undefined before the first design record.
 */
export function designArtifact(task: DeliverySnapshot): string | undefined {
  return task.designCount > 0 ? `.dsh/design/${String(task.id)}.md` : undefined
}

/**
 * Derive the artifact paths a task's record counts imply. The OpenSpec change
 * lives under its own change id rather than the task id, so that path is only
 * listed once a checklist has named the change.
 * @param task - current task snapshot.
 * @param changeId - change id recorded with the checklist, if any.
 */
export function deliveryArtifacts(task: DeliverySnapshot, changeId?: string): readonly string[] {
  const artifacts: string[] = []
  if (task.changeCount > 0) artifacts.push(`.dsh/changes/${String(task.id)}.md`)
  const design = designArtifact(task)
  if (design !== undefined) artifacts.push(design)
  if (task.specCount > 0 && changeId !== undefined) artifacts.push(`openspec/changes/${changeId}/`)
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
