/**
 * Client-namespace projection of the file-changes domain: the browser-safe
 * pure vocabulary (which call mutates which file, and how a path is
 * canonicalized) plus the projection-key types.
 *
 * The browser `ui-deliverables` turn fold classifies a Turn's calls through
 * this module rather than keeping a second copy of the rules, so the host
 * whole-log fold and the client turn fold can never disagree about what counts
 * as a mutation.
 *
 * @module @deepseek-ai/dsh-file-changes/client
 */

export type * from './types.ts'
export { mutationTarget, type MutationTarget } from './mutation.ts'
export { canonicalMutationPath } from './path.ts'
export type { FileChangeOperation as MutationOperation } from './types.ts'
