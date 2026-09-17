/**
 * Programmatic size grading for delivery tasks: the deterministic length floor
 * plus the outcome of one model-backed judgement.
 *
 * Grading is split by nature. A single character floor stays deterministic
 * because an over-long request is almost certainly multi-point delivery, and
 * it is the one measure that cannot be wrong about covering every wording. All
 * remaining `l0`/`l1`/`l2` discrimination is semantic — telling "fix a comment
 * in auth.ts" apart from "change the auth protocol" — so it is delegated to a
 * model call whose rules live in an editable prompt rather than in the code.
 *
 * This module is free of cordis and tool imports so the decision can be tested
 * without a composition.
 * @module @deepseek-ai/dsh-tool-delivery/grading
 */

import type { DeliveryLevel } from '@deepseek-ai/dsh-delivery'

/** Objectives longer than this grade as `l2` without asking a model. */
const CHARACTER_FLOOR = 200

/**
 * The deterministic length floor.
 *
 * This is the only mechanical tier decision: it needs no evidence beyond the
 * request text, it cannot be fooled by wording, and an over-floor request owes
 * the full OpenSpec change set rather than a design document.
 * @param objective - direct human request text.
 * @param floor - the configured character floor to compare against.
 * @returns `l2` when the request exceeds the floor, otherwise `undefined` so
 * the caller proceeds to the model-backed judgement.
 */
export function gradeByLength(objective: string, floor: number): DeliveryLevel | undefined {
  return objective.length > floor ? 'l2' : undefined
}

/** The floor this grader applies when a deployment configures none. */
export const GRADING_CHARACTER_FLOOR = CHARACTER_FLOOR

/** One tier label standing alone on a line, tolerating markdown and punctuation. */
const STANDALONE_LABEL = /^[\s*_`"'（(]*\b(l0|l1|l2)\b[\s*_`"'）).。:,：]*$/im
/** A tier label anywhere in the text, anchored to label boundaries. */
const ANY_LABEL = /\b(l0|l1|l2)\b/i

/**
 * Extract the tier one model response names.
 *
 * The contract with the model is "answer with one tier label and nothing
 * else", so a line that holds only a label is the authoritative answer and is
 * read first — a model that explains its reasoning before answering can
 * otherwise be misread, because a sentence such as "this is not l2, it is l1"
 * names both tiers. Only when no line stands alone does the first label in the
 * text decide, which covers a label wrapped in a short sentence.
 *
 * Matching is anchored to label boundaries, so a longer token such as `l2x` or
 * `l10n` is not read as an answer. A boundary is not a path separator, so text
 * like `src/l0/fixture` does read as a label; the contract asks for a bare
 * label, and a response that names one only inside a path is not a valid answer
 * the parser can distinguish from a real one.
 * @param text - raw model response text.
 * @returns the named tier, or `undefined` when the response names none.
 */
export function parseGradedLevel(text: string): DeliveryLevel | undefined {
  const standalone = STANDALONE_LABEL.exec(text)
  const match = standalone ?? ANY_LABEL.exec(text)
  if (match?.[1] === undefined) return undefined
  return match[1].toLowerCase() as DeliveryLevel
}
