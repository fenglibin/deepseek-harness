/**
 * File-changes plugin: registers the `changedFiles` projection unit, the
 * whole-log changed-file list every client carrier reads.
 *
 * Registration is optional on the projection registry (`ctx.inject`), so a
 * composition without the registry still loads this plugin; its consumer then
 * reads the key as capability absence and falls back to its own window fold.
 *
 * @module @deepseek-ai/dsh-file-changes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { changedFilesProjectionDefinition } from './projection.ts'

export {
  changedFilesProjectionDefinition,
} from './projection.ts'
export {
  changedFilesView, stepFileChanges, type FileChangesState,
} from './fold.ts'
export { mutationTarget, type MutationTarget } from './mutation.ts'
export { canonicalMutationPath } from './path.ts'
export type {
  ChangedFilesProjection, FileChangeEntry, FileChangeOperation,
} from './types.ts'

/**
 * Register the changed-files projection unit.
 * @param ctx - Host context that may carry the projection registry.
 */
export function apply(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(changedFilesProjectionDefinition)
  })
}
