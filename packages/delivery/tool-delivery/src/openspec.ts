/**
 * OpenSpec change layout: change-id validation and artifact path derivation
 * for the four-part change `record_spec` writes.
 * @module @deepseek-ai/dsh-tool-delivery/openspec
 */

/** The four artifacts one OpenSpec change carries. */
export type SpecKind = 'proposal' | 'design' | 'tasks' | 'spec'

/** Change ids are verb-led kebab-case, as OpenSpec requires. */
const CHANGE_ID = /^(?:add|update|remove|refactor)-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Capability directories are kebab-case, as OpenSpec requires. */
const CAPABILITY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** File name of each non-delta artifact inside a change directory. */
const ARTIFACT_NAMES: Record<Exclude<SpecKind, 'spec'>, string> = {
  proposal: 'proposal.md',
  design: 'design.md',
  tasks: 'tasks.md',
}

/**
 * Whether an id is a valid OpenSpec change id.
 * @param value - candidate change id.
 * @returns true for a verb-led kebab-case id.
 */
export function isValidChangeId(value: string): boolean {
  return CHANGE_ID.test(value)
}

/**
 * The repository-relative path one change artifact is written to.
 * @param changeId - verb-led kebab-case change id.
 * @param kind - which of the four artifacts to write.
 * @param capability - capability directory for a spec delta; ignored otherwise.
 * @returns path under `openspec/changes/`.
 * @throws {TypeError} when the change id is malformed, or when a spec delta
 * has no kebab-case capability.
 */
export function changeArtifactPath(changeId: string, kind: SpecKind, capability?: string): string {
  if (!isValidChangeId(changeId)) {
    throw new TypeError(
      `change_id "${changeId}" must be verb-led kebab-case (add-, update-, remove-, refactor-)`,
    )
  }
  if (kind !== 'spec') return `openspec/changes/${changeId}/${ARTIFACT_NAMES[kind]}`
  if (capability === undefined || !CAPABILITY.test(capability)) {
    throw new TypeError('capability must be kebab-case when recording a spec delta')
  }
  return `openspec/changes/${changeId}/specs/${capability}/spec.md`
}
