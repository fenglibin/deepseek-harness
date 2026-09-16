/**
 * Reverse-patch revert: remove one session's file changes from the file as it
 * stands NOW, leaving changes from any other source intact.
 *
 * The session's own contribution is the patch from its baseline to its end
 * state. Reverting applies that patch reversed, hunk by hunk, against the
 * current content rather than against the end state — which is what keeps an
 * edit made outside the session (by the operator, or by another session) in the
 * result.
 *
 * Hunks are applied individually on purpose. A file-wide apply refuses the
 * whole file when any single hunk no longer matches its context, so one
 * unrelated external edit would otherwise block every other hunk in the file.
 * Per-hunk application reverts what still matches and reports the rest.
 *
 * A hunk whose own context was overwritten — the same lines the session touched
 * were changed again afterwards — cannot be reversed without guessing, so it is
 * skipped and reported; the file keeps that hunk as it stands.
 *
 * @module @deepseek-ai/dsh-session-file-revisions/revert
 */

import { applyPatch, createTwoFilesPatch, parsePatch, type StructuredPatch, type StructuredPatchHunk } from 'diff'

/**
 * Context lines `createTwoFilesPatch` emits around each change. The produced
 * patch is internal to this module — it is parsed and reversed, never
 * displayed — so the value only affects how hunks are grouped and how much
 * surrounding text has to match.
 */
const PATCH_CONTEXT = 3

/**
 * Line-distance tolerance when matching a hunk's context. One line absorbs a
 * neighbouring insertion or removal made after the session's change; more would
 * let a hunk land somewhere it does not belong.
 */
const FUZZ_FACTOR = 1

/** How much of a path's reversed patch applied to the current content. */
export type RevertResult =
  /** Every hunk applied; `content` is the file's new content. */
  | { readonly applied: 'all'; readonly content: string }
  /** Some hunks applied; `content` holds those, and the rest are reported by count. */
  | { readonly applied: 'partial'; readonly content: string; readonly skipped: number }
  /** No hunk matched; the file must be left exactly as it is. */
  | { readonly applied: 'none' }

/**
 * A single hunk carried by a shell diff, so one hunk can be applied alone.
 * `applyPatch` reads only the hunk list and the header-less shape it is given,
 * so re-wrapping one hunk in the parsed diff's own shape is enough.
 */
function hunkShell(parsed: StructuredPatch, hunk: StructuredPatchHunk): StructuredPatch {
  return { ...parsed, hunks: [hunk] }
}

/**
 * Remove this session's changes from the file's current content.
 *
 * When the current content already equals the session's end state, the
 * session's changes are the whole difference and the baseline is the answer
 * without building a patch. Otherwise the baseline→end-state patch is reversed
 * and applied hunk by hunk.
 * @param baseline - content before this session's first mutation, or null when it did not exist.
 * @param endState - content after this session's last mutation.
 * @param current - the file's content now.
 * @returns how much applied, with the resulting content when any hunk landed.
 */
export function revertContent(
  baseline: string | null,
  endState: string,
  current: string,
): RevertResult {
  if (current === endState) {
    return baseline === null
      ? { applied: 'all', content: '' }
      : { applied: 'all', content: baseline }
  }
  // `old` is the session's end state and `new` is the baseline, so the patch
  // this produces is already the revert — reversing it would redo the change.
  const patch = createTwoFilesPatch('', '', endState, baseline ?? '', '', '', { context: PATCH_CONTEXT })
  const parsed = parsePatch(patch)[0]
  if (parsed === undefined) return { applied: 'none' }

  let content = current
  let landed = 0
  let skipped = 0
  for (const hunk of parsed.hunks) {
    const next = applyPatch(content, hunkShell(parsed, hunk), { fuzzFactor: FUZZ_FACTOR })
    if (next === false) {
      skipped += 1
      continue
    }
    content = next
    landed += 1
  }
  if (landed === 0) return { applied: 'none' }
  return skipped === 0
    ? { applied: 'all', content }
    : { applied: 'partial', content, skipped }
}
