/**
 * The revision diff panel: one session's cumulative change to one file, shown
 * through the shared {@link DiffBlock} primitive.
 *
 * The panel is pure — it renders what it is handed and owns only its own
 * loading and error text. The baseline and end state come from the Host, already
 * scoped to this session, so what the reader sees is exactly what a revert would
 * remove.
 * @module
 */

import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { DiffBlock, type DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RevisionDiff, RevisionEntry, RevertFileResult } from '@deepseek-ai/dsh-api-session-file-revisions/types'
import css from './RevisionDiffPanel.module.css'

/** The Host verbs the dock drives through the session-revisions Remote. */
export interface RevisionRemote {
  /** Read one file's cumulative diff for the session. */
  diff: (sessionId: string, path: string) => Promise<RevisionDiff>
  /**
   * Revert the given paths, or the whole session when the list is empty.
   * @param paths - canonical absolute paths to revert.
   * @returns one result per attempted path.
   */
  revertAll: (paths: readonly string[]) => Promise<readonly RevertFileResult[]>
}

/** Props of the panel. */
export type RevisionDiffPanelProps = {
  /** Session whose changes are shown. */
  sessionId: string
  /** The file to show; omitted shows every changed file. */
  entry: RevisionEntry | undefined
  /** Every changed file, for the all-files reading. */
  entries: readonly RevisionEntry[]
  /** Reads one file's diff. */
  remote: RevisionRemote
  /** Withdraw the panel. */
  onClose: () => void
} & PropsLocale<'session-changes'>

/**
 * Turn one file's diff into the hunks {@link DiffBlock} draws.
 *
 * A file the session created has no baseline, so its whole content is the added
 * side; an oversized file contributes no hunk at all, and the panel says so.
 * @param diff - the file's cumulative diff.
 * @returns the hunks to render.
 */
export function diffHunks(diff: RevisionDiff): readonly DiffHunk[] {
  if (diff.oversized) return []
  return [{
    path: diff.path,
    oldText: diff.baseline === null ? null : diff.baseline,
    newText: diff.endState,
  }]
}

/**
 * Render one file's cumulative diff, loading it on mount.
 * @param props - see {@link RevisionDiffPanelProps}.
 * @returns the panel element.
 */
export function RevisionDiffPanel({
  sessionId, entry, entries, remote, onClose, t,
}: RevisionDiffPanelProps) {
  const [diffs, setDiffs] = useState<readonly DiffHunk[]>([])
  const [oversized, setOversized] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (entry === undefined) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void remote.diff(sessionId, entry.path).then(
      (diff) => {
        if (cancelled) return
        setDiffs(diffHunks(diff))
        setOversized(diff.oversized)
        setLoading(false)
      },
      (cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoading(false)
      },
    )
    return () => { cancelled = true }
  }, [sessionId, entry, remote])

  return (
    <section className={css.root} data-testid="revision-diff" aria-label={t('diff.title')}>
      <header className={css.header}>
        <span className={css.title}>{t('diff.title')}</span>
        <span className={css.count}>{t('summaryAll', { count: entries.length })}</span>
        <button type="button" className={css.close} onClick={onClose} aria-label={t('diff.close')}>
          {t('diff.close')}
        </button>
      </header>
      {loading && <p className={css.notice}>{t('diff.loading')}</p>}
      {error !== null && <p className={css.error} role="alert">{t('revertFailed', { message: error })}</p>}
      {!loading && error === null && oversized && (
        <p className={css.notice}>{t('diff.oversized')}</p>
      )}
      {!loading && error === null && !oversized && diffs.length === 0 && (
        <p className={css.notice}>{t('diff.empty')}</p>
      )}
      {!loading && !oversized && diffs.length > 0 && (
        <DiffBlock
          className={css.diff}
          diffs={[...diffs]}
          labels={{
            copy: t('diff.copy'),
            copied: t('diff.copied'),
            collapseAria: t('diff.collapseAria'),
            expandAria: (hidden: number) => t('diff.expandAria', { count: hidden }),
            collapse: t('diff.collapse'),
            expand: (hidden: number) => t('diff.expand', { count: hidden }),
            files: (count: number) => t('diff.files', { count }),
          }}
        />
      )}
    </section>
  )
}
