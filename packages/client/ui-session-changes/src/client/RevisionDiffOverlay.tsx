/**
 * The full-screen side-by-side revision viewer: one file's cumulative change for
 * a session, drawn as the two versions the change happened between.
 *
 * It is a read-only review surface, so it optimizes for the reading loop a
 * repository's diff tools train: line numbers on both sides, the changed line
 * highlighted on the side it belongs to, the changed characters marked within a
 * replaced line, and one keystroke between two changes. The unified
 * {@link DiffBlock} answers "what did the agent do" inside a chat row; this
 * answers "show me the file" in the space that needs.
 *
 * @module @deepseek-ai/dsh-client-ui-session-changes/RevisionDiffOverlay
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Modal, grammarLoadCount, highlightLines, languageOfPath, subscribeGrammarLoaded,
  writeClipboard,
  type HighlightSpan,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotMap merge declaring the root-scoped `shell.overlay`
// hole this occupant serves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RevisionDiff } from '@deepseek-ai/dsh-api-session-file-revisions/types'
import { RevisionError, type RevisionRemote } from './revision-remote.ts'
import type { RevisionViewerRequest } from './revision-viewer-request.ts'
import {
  EMPTY_SIDE_BY_SIDE, sideBySide, unifiedDiffText,
  type DiffRow, type DiffSide, type SideBySide,
} from './revision-diff-model.ts'
import css from './RevisionDiffOverlay.module.css'

/** How many changed row-groups the reader can step between. */
export interface RevisionNavigation {
  /** Move to the previous change run; disabled when there is none. */
  readonly previous: () => void
  /** Move to the next change run; disabled when there is none. */
  readonly next: () => void
  /** How many change runs the file has. */
  readonly count: number
  /** Which run the reader is on, or -1 before any jump. */
  readonly current: number
}

/** Props of the overlay. */
export interface RevisionDiffOverlayProps {
  /** Whether the viewer is showing. */
  readonly open: boolean
  /** Session whose revision is shown. */
  readonly sessionId: string
  /** Path of the file being viewed. */
  readonly path: string
  /** How many files this session changed, for the header count. */
  readonly fileCount: number
  /** Reads one file's diff. */
  readonly diff: (sessionId: string, path: string) => Promise<RevisionDiff>
  /** Withdraw the viewer. */
  readonly onClose: () => void
  /** Locale seat: the `session-changes` namespace, injected by the framework. */
  readonly t: PropsLocale<'session-changes'>['t']
}

/** The file's loaded state: still reading, read, or refused. */
type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly diff: RevisionDiff }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * One side's rendered cells for a line, split at the changed interior.
 * @param side - the cell to render.
 * @param spans - the highlighting spans for this side's text.
 * @returns the colored pieces.
 */
function LineBody({ side, spans }: { side: DiffSide; spans: readonly HighlightSpan[] }) {
  if (side.text === null) return null
  const marks = side.spans
  if (marks.length === 0) {
    return <>{piecesFrom(spans)}</>
  }
  // Split the line into unchanged and changed runs, then highlight each run
  // independently: the changed runs keep their own color so the reader sees
  // what moved inside an otherwise-similar line.
  const out: React.ReactNode[] = []
  let at = 0
  for (const [index, mark] of marks.entries()) {
    out.push(<span key={`keep-${String(index)}`}>{sliceHighlighted(side.text, spans, at, mark.start)}</span>)
    out.push(
      <mark key={`mark-${String(index)}`} className={clsx(css.inline, side.kind === 'removed' ? css.inlineDel : css.inlineAdd)}>
        {sliceHighlighted(side.text, spans, mark.start, mark.end)}
      </mark>,
    )
    at = mark.end
  }
  out.push(<span key="tail">{sliceHighlighted(side.text, spans, at, side.text.length)}</span>)
  return <>{out}</>
}

/**
 * The span pieces covering `[start, end)` of one line.
 * @param spans - the line's highlighting spans, in order.
 * @returns the colored pieces.
 */
function piecesFrom(spans: readonly HighlightSpan[]): React.ReactNode[] {
  return spans.map((span, index) => (
    <span key={index} style={span.style}>{span.text}</span>
  ))
}

/**
 * The highlighting spans covering one character range of a line.
 * @param text - the whole line, so an unhighlighted range still renders.
 * @param spans - the line's highlighting spans.
 * @returns the colored pieces for that range.
 */
function sliceHighlighted(
  text: string,
  spans: readonly HighlightSpan[],
  start: number,
  end: number,
): React.ReactNode[] {
  if (start >= end) return []
  const out: React.ReactNode[] = []
  let at = 0
  for (const [index, span] of spans.entries()) {
    const spanStart = at
    const spanEnd = at + span.text.length
    at = spanEnd
    const from = Math.max(start, spanStart)
    const to = Math.min(end, spanEnd)
    if (from >= to) continue
    out.push(
      <span key={index} style={span.style}>
        {span.text.slice(from - spanStart, to - spanStart)}
      </span>,
    )
  }
  // A range past the last span (the tokenizer can drop a trailing newline
  // marker) still renders as plain text rather than vanishing.
  if (at < end) out.push(<span key="rest">{text.slice(at, end)}</span>)
  return out
}

/** One column of one row, with its line number gutter. */
function DiffCell({ side, spans }: { side: DiffSide; spans: readonly HighlightSpan[] }) {
  return (
    <div className={clsx(css.cell, css[side.kind])} data-kind={side.kind}>
      <span className={css.gutter} aria-hidden>{side.number ?? ''}</span>
      <code className={css.code}>
        <LineBody side={side} spans={spans} />
      </code>
    </div>
  )
}

/**
 * Line count past which the body collapses its middle.
 *
 * The viewer shows a whole file on purpose — the space exists and a collapsed
 * diff hides precisely what the reader opened it for. The cap is the one case
 * where that intent loses: a generated or vendored file of tens of thousands of
 * lines would make two highlighted columns unusable, so past this bound the
 * middle folds behind a control.
 */
export const MAX_VISIBLE_ROWS = 2_000

/**
 * Render one file's cumulative revision as a full-screen split view.
 * @param props - see {@link RevisionDiffOverlayProps}.
 * @returns the viewer element, or null while closed.
 */
export function RevisionDiffOverlay({
  open, sessionId, path, fileCount, diff, onClose, t,
}: RevisionDiffOverlayProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [current, setCurrent] = useState(-1)
  const [languageLoaded, setLanguageLoaded] = useState(0)
  const leftPane = useRef<HTMLDivElement | null>(null)
  const rightPane = useRef<HTMLDivElement | null>(null)
  const syncing = useRef(false)
  // The read is a transport, not an input: keying the load on the callback's
  // identity would restart it on every parent render that rebuilt the closure,
  // leaving the viewer permanently loading.
  const readDiff = useRef(diff)
  readDiff.current = diff

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setState({ kind: 'loading' })
    setExpanded(false)
    setCurrent(-1)
    void readDiff.current(sessionId, path).then(
      (result) => { if (!cancelled) setState({ kind: 'loaded', diff: result }) },
      (cause: unknown) => {
        if (cancelled) return
        setState({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) })
      },
    )
    return () => { cancelled = true }
  }, [open, sessionId, path])

  // A lazily-loaded grammar re-renders the body once it arrives; until then the
  // text renders plain rather than blocking the view on a grammar module.
  useEffect(() => subscribeGrammarLoaded(() => { setLanguageLoaded(grammarLoadCount()) }), [])

  const projection: SideBySide = useMemo(() => {
    if (state.kind !== 'loaded') return EMPTY_SIDE_BY_SIDE
    if (state.diff.withheld !== null) return EMPTY_SIDE_BY_SIDE
    return sideBySide(state.diff.baseline, state.diff.endState)
  }, [state])

  const lang = useMemo(() => languageOfPath(path), [path])
  const leftSpans = useMemo(
    () => highlightLines(projection.rows.map(row => row.left.text ?? '').join('\n'), lang),
    [projection, lang, languageLoaded],
  )
  const rightSpans = useMemo(
    () => highlightLines(projection.rows.map(row => row.right.text ?? '').join('\n'), lang),
    [projection, lang, languageLoaded],
  )

  const capped = projection.rows.length > MAX_VISIBLE_ROWS && !expanded
  const visible = capped ? projection.rows.slice(0, MAX_VISIBLE_ROWS) : projection.rows

  // Two columns of one file must stay on the same row, so their horizontal
  // offsets move together. The guard breaks the echo: a scroll caused by this
  // handler would otherwise fire the other pane's handler and come back.
  const mirror = useCallback((from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (from === null || to === null || syncing.current) return
    syncing.current = true
    to.scrollLeft = from.scrollLeft
    // Released on the next frame: clearing it synchronously would let the
    // echoed event re-enter before the browser has applied the assignment.
    window.requestAnimationFrame(() => { syncing.current = false })
  }, [])

  // Which row the reader is currently on, if any. A row is "current" when it
  // opens the change run they stepped to, so the marker lands on the run's
  // first row rather than on whichever row happens to share its index.
  const isCurrent = useCallback(
    (row: DiffRow, index: number): boolean =>
      current >= 0 && row.changeRun && projection.changeRuns[current] === index,
    [current, projection],
  )

  const jumpTo = useCallback((run: number) => {
    const target = projection.changeRuns[run]
    if (target === undefined) return
    setCurrent(run)
    // Scrolling the lane itself rather than one row: the two lanes are separate
    // scroll containers, and scrolling a row would move only the lane that
    // holds it. `block: 'nearest'` keeps the movement local when the row is
    // already visible.
    const anchor = leftPane.current?.querySelector(`[data-change-run="${String(target)}"]`)
    // Optional: the method is a browser affordance, so a non-browser renderer
    // (and a test environment) keeps the position update without scrolling.
    anchor?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [projection])

  const step = useCallback((delta: number) => {
    if (projection.changeRuns.length === 0) return
    const next = current < 0
      ? (delta > 0 ? 0 : projection.changeRuns.length - 1)
      : (current + delta + projection.changeRuns.length) % projection.changeRuns.length
    jumpTo(next)
  }, [current, projection, jumpTo])

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(unifiedDiffText(projection)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, projection])

  // The shortcut is bound on the document, not on this subtree: a reader's
  // keystroke goes to whatever holds focus, which after opening the viewer is
  // the document body — never an element inside the dialog. A handler on the
  // dialog's own div would advertise a key that no reader could press. This is
  // the same binding Modal uses for Escape.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'j') { event.preventDefault(); step(1) }
      if (event.key === 'k') { event.preventDefault(); step(-1) }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, step])

  const file = useMemo(() => path.split(/[/\\]/).pop() ?? path, [path])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('diff.title')}
      className={css.frame ?? ''}
      headless
    >
      <div className={css.root}>
        <header className={css.header}>
          <div className={css.identity}>
            <span className={css.file} title={path}>{file}</span>
            <span className={css.directory}>{path}</span>
          </div>
          {state.kind === 'loaded' && projection.rows.length > 0 && (
            <span className={css.totals}>
              <span className={css.totalAdded}>+{projection.added}</span>
              <span className={css.totalRemoved}>-{projection.removed}</span>
            </span>
          )}
          <span className={css.count}>{t('summaryAll', { count: fileCount })}</span>
          <button
            type="button"
            className={css.action}
            onClick={onCopy}
            disabled={projection.rows.length === 0}
          >
            {copied ? t('diff.copied') : t('diff.copy')}
          </button>
          <button type="button" className={css.close} onClick={onClose} aria-label={t('diff.close')}>
            {t('diff.close')}
          </button>
        </header>

        {state.kind === 'loaded' && state.diff.withheld === null && projection.rows.length > 0 && (
          <div className={css.columns} aria-hidden>
            <span className={css.columnLabel}>{t('diff.baseline')}</span>
            <span className={css.columnLabel}>{t('diff.current')}</span>
          </div>
        )}

        <div className={css.body}>
          {state.kind === 'loading' && <p className={css.notice}>{t('diff.loading')}</p>}
          {state.kind === 'failed' && <p className={css.error} role="alert">{state.message}</p>}
          {state.kind === 'loaded' && state.diff.withheld === 'oversized' && (
            <p className={css.notice}>{t('diff.oversized')}</p>
          )}
          {state.kind === 'loaded' && state.diff.withheld === 'baseline-missing' && (
            <p className={css.notice}>{t('diff.baselineMissing')}</p>
          )}
          {state.kind === 'loaded' && state.diff.withheld === null && projection.rows.length === 0 && (
            <p className={css.notice}>{t('diff.empty')}</p>
          )}
          {state.kind === 'loaded' && state.diff.withheld === null && projection.rows.length > 0 && (
            <div className={css.panes}>
              {/* Every row is wrapped identically in BOTH lanes: the marker that
                  points at the current change belongs on the row's two halves,
                  and the scroll anchor has to exist in each lane. */}
              <div className={css.pane} ref={leftPane} onScroll={() => { mirror(leftPane.current, rightPane.current) }}>
                <div className={css.paneInner}>
                  {visible.map((row, index) => (
                    <div
                      key={index}
                      data-change-run={row.changeRun ? index : undefined}
                      data-focused={isCurrent(row, index) ? 'true' : undefined}
                      className={clsx(isCurrent(row, index) && css.focused)}
                    >
                      <DiffCell side={row.left} spans={leftSpans?.[index] ?? []} />
                    </div>
                  ))}
                </div>
              </div>
              <div className={css.pane} ref={rightPane} onScroll={() => { mirror(rightPane.current, leftPane.current) }}>
                <div className={css.paneInner}>
                  {visible.map((row, index) => (
                    <div
                      key={index}
                      data-change-run={row.changeRun ? index : undefined}
                      data-focused={isCurrent(row, index) ? 'true' : undefined}
                      className={clsx(isCurrent(row, index) && css.focused)}
                    >
                      <DiffCell side={row.right} spans={rightSpans?.[index] ?? []} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {capped && (
            <button type="button" className={css.more} onClick={() => { setExpanded(true) }}>
              {t('diff.expand', { count: projection.rows.length - MAX_VISIBLE_ROWS })}
            </button>
          )}
        </div>

        <footer className={css.footer}>
          <span className={css.hint}>{t('diff.hint')}</span>
          <div className={css.steps}>
            <button
              type="button"
              className={css.step}
              onClick={() => { step(-1) }}
              disabled={projection.changeRuns.length === 0}
            >
              {t('diff.previous')}
            </button>
            <span className={css.position}>
              {current < 0
                ? t('diff.changes', { count: projection.changeRuns.length })
                : t('diff.position', { current: current + 1, count: projection.changeRuns.length })}
            </span>
            <button
              type="button"
              className={css.step}
              onClick={() => { step(1) }}
              disabled={projection.changeRuns.length === 0}
            >
              {t('diff.next')}
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  )
}

export type { DiffRow, SideBySide }

/** Injected face: the shared request source, the close callback, and the Remote verbs. */
export interface RevisionViewerInjected {
  hooks: {
    /** The file currently being viewed, or undefined while the viewer is closed. */
    request: HostObservable<RevisionViewerRequest | undefined>
  }
  /** Withdraw the current request, closing the viewer. */
  onClose: () => void
  /** The Remote verbs the viewer drives; absent when this composition captures no revisions. */
  revisions: RevisionRemote | undefined
}

/** Full composed props of the viewer occupant. */
export type RevisionViewerOccupantProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<RevisionViewerInjected>
  & PropsLocale<'session-changes'>

/**
 * The `shell.overlay` occupant: it subscribes to the shared open-request source
 * and renders {@link RevisionDiffOverlay} for whichever file is current.
 *
 * It renders nothing at all while no request is open, which is what keeps the
 * click-through overlay layer free of an invisible full-frame hit target.
 * @param props - composed slot props (the request hook, the close callback, the Remote verbs, the locale seat).
 * @returns the viewer element, or null while closed.
 */
export function RevisionViewerOccupant({ useRequest, onClose, revisions, t }: RevisionViewerOccupantProps) {
  const request = useRequest(current => current)
  const diff = useCallback(
    (sessionId: string, path: string): Promise<RevisionDiff> => {
      if (revisions === undefined) {
        return Promise.reject(new RevisionError('session-revisions/unavailable', 'revisions unavailable'))
      }
      return revisions.diff(sessionId, path)
    },
    [revisions],
  )
  if (request === undefined) return null
  return (
    <RevisionDiffOverlay
      open
      sessionId={request.sessionId}
      path={request.path}
      fileCount={request.fileCount}
      diff={diff}
      onClose={onClose}
      t={t}
    />
  )
}
