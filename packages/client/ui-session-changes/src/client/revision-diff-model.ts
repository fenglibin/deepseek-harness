/**
 * The side-by-side diff model: turn one file's before/after text into the
 * aligned rows a split view draws, plus the inline character ranges marking what
 * changed WITHIN a replaced line.
 *
 * A split view is not a rendering choice over the unified diff — it is a
 * different projection of it. Unified output lists every removal and then every
 * addition, leaving the reader to reconstruct "this line became that one". This
 * model does that reconstruction once: the nth removal of a run pairs with the
 * nth addition of the same run, so a replacement occupies ONE row and the two
 * columns stay line-for-line comparable. A side with no partner gets a filler
 * row, which is what keeps the two columns the same height and their line
 * numbers aligned.
 *
 * @module @deepseek-ai/dsh-client-ui-session-changes/revision-diff-model
 */

import { diffChars, structuredPatch } from 'diff'

/**
 * Longest line whose interior is character-diffed.
 *
 * The character diff is quadratic in the worst case, and a minified bundle or a
 * generated file can hold one line of hundreds of kilobytes. Past this bound the
 * row keeps its whole-line highlight and skips the interior marks: the reader
 * still sees which line changed, at no risk of stalling the render.
 */
export const MAX_INLINE_DIFF_CHARS = 2_000

/** How a side's line participates in the change. */
export type DiffSideKind =
  /** Unchanged on both sides. */
  | 'context'
  /** Present before, changed or gone now. */
  | 'removed'
  /** Present now, added or changed. */
  | 'added'
  /** This side has no line here; the row exists to keep the columns aligned. */
  | 'filler'

/** One half-open character range within a line, marking the changed interior. */
export interface InlineSpan {
  readonly start: number
  readonly end: number
}

/** One column's cell in a diff row. */
export interface DiffSide {
  /** 1-based line number on this side, or null for a filler cell. */
  readonly number: number | null
  /** The line's text without its terminator, or null for a filler cell. */
  readonly text: string | null
  readonly kind: DiffSideKind
  /** Changed interior ranges; empty unless both sides of the row carry text. */
  readonly spans: readonly InlineSpan[]
}

/** One aligned row: the two columns a split view draws side by side. */
export interface DiffRow {
  readonly left: DiffSide
  readonly right: DiffSide
  /** Zero-based hunk index; a value change from the previous row opens a hunk. */
  readonly hunk: number
  /** True when this row starts a contiguous change run — a navigation target. */
  readonly changeRun: boolean
}

/** One file's before/after projected for a split view. */
export interface SideBySide {
  readonly rows: readonly DiffRow[]
  /** Added lines, counted as lines rather than rows. */
  readonly added: number
  /** Removed lines, counted as lines rather than rows. */
  readonly removed: number
  /** First row index of each hunk, for the `@@` headers between them. */
  readonly hunkStarts: readonly number[]
  /** Row indexes that begin a change run, in order — the navigation targets. */
  readonly changeRuns: readonly number[]
}

/** An empty projection: no rows and no counts. */
export const EMPTY_SIDE_BY_SIDE: SideBySide = {
  rows: [], added: 0, removed: 0, hunkStarts: [], changeRuns: [],
}

/**
 * Merge adjacent ranges so a run of changed characters reads as one span.
 * @param spans - the ranges in ascending order.
 * @returns the merged ranges.
 */
function mergeSpans(spans: readonly InlineSpan[]): readonly InlineSpan[] {
  const merged: InlineSpan[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.end === span.start) {
      merged[merged.length - 1] = { start: last.start, end: span.end }
      continue
    }
    merged.push(span)
  }
  return merged
}

/**
 * The changed interiors of one replaced line, per side.
 *
 * Offsets are into the ORIGINAL text, so the caller can slice the line it
 * already holds rather than re-deriving it from the diff's own segments.
 * @param left - the removed side's line.
 * @param right - the added side's line.
 * @returns each side's changed ranges, merged and ascending.
 */
function inlineSpans(left: string, right: string): { left: readonly InlineSpan[]; right: readonly InlineSpan[] } {
  if (left.length > MAX_INLINE_DIFF_CHARS || right.length > MAX_INLINE_DIFF_CHARS) {
    return { left: [], right: [] }
  }
  const leftSpans: InlineSpan[] = []
  const rightSpans: InlineSpan[] = []
  let atLeft = 0
  let atRight = 0
  for (const part of diffChars(left, right)) {
    const length = part.value.length
    if (part.removed === true) {
      leftSpans.push({ start: atLeft, end: atLeft + length })
      atLeft += length
      continue
    }
    if (part.added === true) {
      rightSpans.push({ start: atRight, end: atRight + length })
      atRight += length
      continue
    }
    atLeft += length
    atRight += length
  }
  return { left: mergeSpans(leftSpans), right: mergeSpans(rightSpans) }
}

/** One pending line of a change run, before pairing. */
interface PendingLine {
  readonly text: string
  /** 1-based line number on its own side. */
  readonly number: number
}

/**
 * Project one file's two versions onto aligned split-view rows.
 *
 * `before` is null for a file this session created; its removed side is then
 * empty, exactly as a repository shows a new file's left column. Identical
 * versions produce no rows at all, which the caller reports as "no changes"
 * rather than as a diff of nothing.
 * @param before - content before this session's first mutation, or null when absent.
 * @param after - content after this session's last mutation.
 * @returns the aligned rows and their counts.
 */
export function sideBySide(before: string | null, after: string): SideBySide {
  const oldText = before ?? ''
  if (oldText === after) return EMPTY_SIDE_BY_SIDE
  const patch = structuredPatch('', '', oldText, after, '', '', { context: 3 })
  const rows: DiffRow[] = []
  const hunkStarts: number[] = []
  const changeRuns: number[] = []
  let added = 0
  let removed = 0

  for (const [hunkIndex, hunk] of patch.hunks.entries()) {
    hunkStarts.push(rows.length)
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    let pendingRemoved: PendingLine[] = []
    let pendingAdded: PendingLine[] = []
    let previousWasChange = false

    /** Emit one change run: nth removal beside nth addition, filler for the surplus. */
    const flush = (): void => {
      if (pendingRemoved.length === 0 && pendingAdded.length === 0) return
      const runStart = rows.length
      const pairs = Math.max(pendingRemoved.length, pendingAdded.length)
      for (let index = 0; index < pairs; index += 1) {
        const removedLine = pendingRemoved[index]
        const addedLine = pendingAdded[index]
        // Both sides present is a replacement, so the row earns interior marks;
        // a one-sided row is a pure insertion or deletion and has nothing to
        // compare the other column against.
        const spans = removedLine !== undefined && addedLine !== undefined
          ? inlineSpans(removedLine.text, addedLine.text)
          : { left: [], right: [] }
        rows.push({
          hunk: hunkIndex,
          changeRun: index === 0,
          left: {
            number: removedLine?.number ?? null,
            text: removedLine?.text ?? null,
            kind: removedLine === undefined ? 'filler' : 'removed',
            spans: spans.left,
          },
          right: {
            number: addedLine?.number ?? null,
            text: addedLine?.text ?? null,
            kind: addedLine === undefined ? 'filler' : 'added',
            spans: spans.right,
          },
        })
      }
      removed += pendingRemoved.length
      added += pendingAdded.length
      if (!previousWasChange) changeRuns.push(runStart)
      previousWasChange = true
      pendingRemoved = []
      pendingAdded = []
    }

    for (const line of hunk.lines) {
      const marker = line.charAt(0)
      const text = line.slice(1)
      // `\ No newline at end of file` annotates the patch rather than naming a
      // line of the file. Drawing it would show text the file does not contain
      // and shift every line number after it.
      if (marker === '\\') continue
      if (marker === '-') {
        pendingRemoved.push({ text, number: oldLine })
        oldLine += 1
        continue
      }
      if (marker === '+') {
        pendingAdded.push({ text, number: newLine })
        newLine += 1
        continue
      }
      // A context line closes any open run and advances both sides together.
      flush()
      previousWasChange = false
      rows.push({
        hunk: hunkIndex,
        changeRun: false,
        left: { number: oldLine, text, kind: 'context', spans: [] },
        right: { number: newLine, text, kind: 'context', spans: [] },
      })
      oldLine += 1
      newLine += 1
    }
    flush()
  }

  return { rows, added, removed, hunkStarts, changeRuns }
}

/**
 * The standard unified diff a reader copies.
 *
 * Copying emits `-`/`+` lines rather than the screen's two-column arrangement:
 * what lands in a terminal, an issue, or a patch file has to be a diff those
 * tools accept, and a side-by-side transcript is not one.
 * @param projected - the aligned projection to render as unified text.
 * @returns the diff as plain text.
 */
export function unifiedDiffText(projected: SideBySide): string {
  const lines: string[] = []
  for (const row of projected.rows) {
    if (row.left.text !== null && row.left.kind === 'context') {
      lines.push(` ${row.left.text}`)
      continue
    }
    if (row.left.text !== null) lines.push(`-${row.left.text}`)
    if (row.right.text !== null) lines.push(`+${row.right.text}`)
  }
  return lines.join('\n')
}
