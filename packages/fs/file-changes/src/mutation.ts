/**
 * The one vocabulary of first-party file mutations: which `tool/call` names
 * mutate a file, which argument carries its path, and which user-visible
 * operation kind each one is.
 *
 * Both consumers read this module rather than re-deriving the rules — the host
 * `changedFiles` projection unit folds the complete log through it, and the
 * browser `ui-deliverables` turn fold classifies a turn's calls through it.
 * Two copies of this table would have to agree forever on what counts as a
 * mutation, which is exactly the duplication the single home removes.
 *
 * A call counts only when it is COMPLETE for its command: an `edit` with an
 * empty `old_string`, a `write` with no `content`, or an `str_replace_editor`
 * invocation with an unsupported command never mutated a file, so it is not a
 * change. Read-only commands (`view`) and unsupported tools contribute nothing.
 *
 * @module @deepseek-ai/dsh-file-changes/mutation
 */

import type { FileChangeOperation } from './types.ts'

/** One resolved mutation call: the path it names and its user-visible kind. */
export interface MutationTarget {
  /** Path exactly as the model spelled it; callers canonicalize before comparing. */
  readonly path: string
  readonly operation: FileChangeOperation
}

/** The user-visible mutation kind for one supported wire tool name. */
function mutationOperation(name: string): FileChangeOperation | null {
  switch (name) {
    case 'write': return 'write'
    case 'edit':
    case 'str_replace_editor': return 'edit'
    default: return null
  }
}

/** A non-blank path preserves the exact spelling supplied to the tool. */
function pathValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** Narrow parsed JSON to an argument object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the fields an `edit` execution requires. */
function validEditArgs(args: Readonly<Record<string, unknown>>): boolean {
  return typeof args['old_string'] === 'string'
    && args['old_string'].length > 0
    && typeof args['new_string'] === 'string'
    && args['old_string'] !== args['new_string']
    && (args['replace_all'] === undefined || typeof args['replace_all'] === 'boolean')
}

/** Extract a path only from a complete mutating editor command. */
function editorMutationPath(args: Readonly<Record<string, unknown>>): string | null {
  const path = pathValue(args['path'])
  if (path === null) return null
  switch (args['command']) {
    case 'create':
      return typeof args['file_text'] === 'string' ? path : null
    case 'str_replace':
      return typeof args['old_str'] === 'string'
        && args['old_str'].length > 0
        && (args['new_str'] === undefined || typeof args['new_str'] === 'string')
        ? path
        : null
    case 'insert':
      return typeof args['insert_line'] === 'number'
        && Number.isInteger(args['insert_line'])
        && args['insert_line'] >= 0
        && typeof args['new_str'] === 'string'
        ? path
        : null
    default:
      return null
  }
}

/**
 * The path one supported mutation call names.
 *
 * Only the three names {@link mutationOperation} admits reach here, so the
 * remaining case is `str_replace_editor`.
 */
function mutationPath(name: string, args: Readonly<Record<string, unknown>>): string | null {
  switch (name) {
    case 'write':
      return typeof args['content'] === 'string' ? pathValue(args['file_path']) : null
    case 'edit':
      return validEditArgs(args) ? pathValue(args['file_path']) : null
    default:
      return editorMutationPath(args)
  }
}

/**
 * Resolve one `tool/call` to the mutation it would apply, or null when it is
 * not a supported, complete mutation call.
 * @param name - wire tool name exactly as the call recorded it.
 * @param argsRaw - the call's model-produced JSON arguments.
 * @returns the named path with its operation kind, or null.
 */
export function mutationTarget(name: string, argsRaw: string): MutationTarget | null {
  const operation = mutationOperation(name)
  if (operation === null) return null
  let args: unknown
  try {
    args = JSON.parse(argsRaw) as unknown
  } catch {
    return null
  }
  if (!isRecord(args)) return null
  const path = mutationPath(name, args)
  return path === null ? null : { path, operation }
}
