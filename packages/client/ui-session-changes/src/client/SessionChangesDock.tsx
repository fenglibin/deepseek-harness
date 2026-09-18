/**
 * SessionChangesDock: the changed-files list docked above the message composer
 * (input dock strip). It shows every file the agent mutated in this Session and
 * lets the user accept a file to clear it from the pending list.
 *
 * The list's source is the host `changedFiles` projection, which folds the
 * COMPLETE durable log — a client that has paged in only the tail of a long
 * Session still sees every changed file. When that projection is absent (a
 * composition with no projection registry) the dock falls back to folding the
 * Turns the client has loaded, which is the same shape over a smaller window.
 *
 * Accepting changes nothing on disk; it is a surface-only dismissal. Accept is
 * remembered against the seq of the change the reader saw, so a file the agent
 * mutates again AFTER the accept returns to the pending list. Reject is
 * deliberately out of scope (no per-call prior-content snapshot exists to roll
 * a file back).
 *
 * The screen offers two readings of the SAME data: the pending list, and every
 * file the Session changed including the accepted ones. Both derive from the
 * projection plus the accept record, so a path occupies at most one row in
 * either. The record lives in a session-scoped store rather than component
 * state, because a rebind (reload, or switching Sessions and back) would
 * otherwise resurrect every accepted path at once; see `./accept-store.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the `deliverables` ConversationTurnDataMap key merge and its
// mutation operation kind. Type imports are erased, so the shared vocabulary
// reaches this plugin without a cross-plugin value import.
import type { MutationOperation } from '@deepseek-ai/dsh-client-ui-deliverables/client'
// Type-only: the `changedFiles` SessionProjectionMap key merge, so
// `useProjection('changedFiles')` resolves to the whole-log list. The value
// import of the shared vocabulary rides the same package's `/client` outlet.
import type {} from '@deepseek-ai/dsh-file-changes/client'
import { canonicalMutationPath } from '@deepseek-ai/dsh-file-changes/client'
// Type-only: the `chat` ConversationViewSnapshotMap key merge, so
// `conversation.views.get('chat')` resolves to the chat snapshot with its timeline.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronUpOutline14, IconEditOutline16, IconEyeOutline16,
  IconUndoOutline16, RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createAcceptedChangesStore, summarize, type AcceptedChanges, type RevertSummary,
} from './accept-store.ts'
import { revisionFailureText, revertBlockedText, type RevisionRemote } from './revision-remote.ts'
import type { RevisionViewerRequest } from './revision-viewer-request.ts'
import css from './SessionChangesDock.module.css'

export { canonicalMutationPath }

/**
 * Key standing for "every recorded path" in the in-flight revert set.
 *
 * A real path is always absolute and therefore starts with a separator or a
 * drive letter, so this spelling cannot collide with one.
 */
const ALL_PATHS = '*'

/** One path's revert outcome, as the Remote reports it. */
type RevertFileResult = Awaited<ReturnType<RevisionRemote['revert']>>[number]

/**
 * Host capability facts the dock registration injects into the entry.
 * Both members are plain data or callbacks — components never see ctx.
 */
export interface SessionChangesInjected {
  /** Session Workspace root; relative mutation paths resolve against it. */
  readonly cwd: string | undefined
  /**
   * Hand one changed file's already-canonical path to the Host desktop opener.
   * @param path - absolute path as the list shows it.
   * @returns settles once the Host accepts the path.
   * @throws Error carrying the Host's refusal reason.
   */
  openFile: (path: string) => Promise<void>
  /**
   * The session-revision Remote verbs, or undefined when this composition
   * captures no revisions. Its absence is what turns the view-diff and revert
   * controls off while leaving the list intact.
   */
  revisions: RevisionRemote | undefined
  /**
   * Ask the full-screen viewer to show one file's change.
   *
   * The viewer lives outside every session (it occupies a root-scoped overlay),
   * so the dock cannot render it directly — it publishes a request the overlay
   * occupant picks up.
   */
  openViewer: (request: RevisionViewerRequest) => void
}

/** Full props of the dock entry: session standard kit (`useConversation`) + the injected opener + the accept store + the locale seat. */
export type SessionChangesDockProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<SessionChangesInjected>
  & PropsStore<ReturnType<typeof createAcceptedChangesStore>>
  & PropsLocale<'session-changes'>

/**
 * One session change: the produced path, its user-visible operation kind, and
 * the seq bounds of the mutations that produced it.
 *
 * `lastSeq` is what accept acts against: it is the identity of the newest
 * change the list is showing for this path, so a later mutation is
 * distinguishable from the one the reader dismissed.
 */
export interface SessionChange {
  readonly path: string
  readonly operation: MutationOperation
  /** Seq of this path's earliest mutation; decides the list's first-seen order. */
  readonly firstSeq: number
  /** Seq of this path's latest mutation; what an accept is recorded against. */
  readonly lastSeq: number
}

/** Leading directory of one path, kept with its trailing separator. */
function directoryOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? '' : path.slice(0, at + 1)
}

/**
 * Workspace-relative spelling of one canonical path, for display. The fold
 * and the Host opener both work on the absolute path; the row shows the
 * spelling the reader navigates the Workspace by. A path outside the
 * Workspace, or a Session with no Workspace root, keeps the absolute form —
 * there is no shorter spelling that still names it.
 * @param path - canonical absolute path.
 * @param cwd - Session Workspace root; absent keeps the path as it is.
 * @returns the path to render.
 */
export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined) return path
  const root = cwd.replace(/[/\\]+$/, '')
  return root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/**
 * Fold every turn's produced changes into one session-wide first-seen list.
 * A file written and then edited this session stays one entry, with the
 * earliest operation kind, and so does a file the model spelled differently
 * across calls. `useConversation` returns a stable reference until the
 * conversation changes, so the memo re-runs only on new material.
 *
 * This is the FALLBACK reader: it sees only the Turns the client has paged in,
 * so a long Session's earlier changes are invisible to it. The `changedFiles`
 * projection is the primary source; this fold keeps the dock working in a
 * composition that mounts no projection registry.
 * @param conversation - the current Session's assembled Conversation snapshot.
 * @param cwd - Session Workspace root used to canonicalize relative paths.
 * @returns the session's produced changes in first-seen order.
 */
export function sessionChanges(conversation: ConversationSnapshot, cwd?: string): readonly SessionChange[] {
  const chat = conversation.views.get('chat')
  if (chat === undefined) return []
  const seen = new Map<string, SessionChange>()
  // The fold below is seq-driven, so the order turns are visited in cannot
  // change the result — which is what makes it safe to walk the turns Map
  // directly rather than `turnOrder` (the two are derived from each other, and
  // the Map is the one that always holds every turn).
  for (const turn of chat.timeline.turns.values()) {
    const deliverables = turn.data.get('deliverables')
    if (deliverables === undefined) continue
    for (const produced of deliverables.produced) {
      const path = canonicalMutationPath(produced.path, cwd)
      const previous = seen.get(path)
      if (previous === undefined) {
        seen.set(path, {
          path, operation: produced.operation, firstSeq: produced.seq, lastSeq: produced.seq,
        })
        continue
      }
      // Fold by seq rather than by arrival: the EARLIEST mutation owns the
      // operation kind and `firstSeq`, the LATEST owns `lastSeq`. Folding this
      // way makes the result independent of arrival order — which is what keeps
      // `lastSeq` monotonic. The accept rule compares against it, so a value
      // that could move backwards would hide a change the reader never
      // accepted.
      seen.set(path, {
        path,
        operation: produced.seq < previous.firstSeq ? produced.operation : previous.operation,
        firstSeq: Math.min(previous.firstSeq, produced.seq),
        lastSeq: Math.max(previous.lastSeq, produced.seq),
      })
    }
  }
  return [...seen.values()].sort((left, right) => left.firstSeq - right.firstSeq)
}

/**
 * Whether one changed path still awaits the reader's attention: it has no
 * accept at all, or the list has moved past the seq that was accepted.
 *
 * This one comparison is what makes "accept, then the agent edits it again"
 * put the file back, so `pendingChanges` and the row's accept control both read
 * it rather than restating the rule.
 * @param change - one changed path with its seq bounds.
 * @param accepted - one accepted `lastSeq` per path.
 * @returns true when the path is pending.
 */
export function isPendingChange(change: SessionChange, accepted: AcceptedChanges): boolean {
  const acceptedSeq = accepted[change.path]
  return acceptedSeq === undefined || change.lastSeq > acceptedSeq
}

/**
 * The changes still awaiting the reader's attention, in the input's order.
 * @param changes - the Session's changed files, in first-seen order.
 * @param accepted - one accepted `lastSeq` per path.
 * @returns the pending changes.
 */
export function pendingChanges(
  changes: readonly SessionChange[],
  accepted: AcceptedChanges,
): readonly SessionChange[] {
  return changes.filter(change => isPendingChange(change, accepted))
}

/** Which reading of the changed-file list the panel shows. */
export type ChangesView = 'pending' | 'all'

/** Props of the pure list panel: the folded changes, the accept record, and the locale seat. */
export type SessionChangesPanelProps = {
  changes: readonly SessionChange[]
  /** Accepted `lastSeq` per path, owned by the accept store so it outlives this mount. */
  accepted: AcceptedChanges
  /** Record one file's accept at the seq the reader saw. */
  onAccept: (change: SessionChange) => void
  /** Mark every pending file accepted at the seq the reader saw. */
  onAcceptAll: (changes: readonly SessionChange[]) => void
  /** Hand one changed file to the Host desktop opener; rejects when it refuses. */
  openFile: (path: string) => Promise<void>
  /** Session Workspace root; rows are spelled relative to it. */
  cwd: string | undefined
  /**
   * Open one file's cumulative diff, or undefined when this composition
   * captures no revisions and the action is not offered.
   */
  onViewDiff?: ((change: SessionChange) => void) | undefined
  /**
   * Whether one path has a recorded revision, so the diff and revert controls
   * can be offered for it. The changed-file list and the revision record have
   * different lifetimes, so a listed path is not always a viewable one.
   */
  hasRevision: (path: string) => boolean
  /** Whether a revert is running, so the control can say so. */
  reverting?: boolean | undefined
  /** Revert every file this session changed; undefined when not offered. */
  onRevertAll?: (() => void) | undefined
  /**
   * Revert one file's changes in this session, or undefined when this
   * composition offers no revert at all.
   */
  onRevertOne?: ((change: SessionChange) => void) | undefined
  /** Paths whose revert is running, so one row's revert does not disable another's. */
  revertingPaths?: ReadonlySet<string> | undefined
  /**
   * What each path's record says about its line counts and origin, as the Host
   * reports it. A path absent from the map has no recorded revision, so the row
   * shows neither counts nor a deletion state.
   */
  recordedInfo?: ReadonlyMap<string, RecordedInfo> | undefined
} & PropsLocale<'session-changes'>

/**
 * What one path's Host record says to the list, beyond its mere presence.
 *
 * `origin` is what distinguishes a file the session changed from one it deleted:
 * a deleted path has no meaningful line counts, so the row reports the deletion
 * itself instead of two numbers that would both read zero. The seq bounds are
 * what let a path only this record knows about be placed among the folded rows.
 */
export interface RecordedInfo {
  /** Added and removed line counts of the session's cumulative change. */
  readonly added: number
  readonly removed: number
  /** What the session's first mutation found, as the Host recorded it. */
  readonly origin: 'existing' | 'absent' | 'unknown' | 'deleted'
  /** Seq of the path's earliest recorded position; decides its first-seen order. */
  readonly firstSeq: number
  /** Seq of the path's latest recorded position; what an accept is measured against. */
  readonly lastSeq: number
}

/**
 * Add the paths only the revision record knows about to the folded list.
 *
 * The changed-files fold reads the durable log's write calls, so a file a shell
 * command deleted appears nowhere in it: no `write` or `edit` ever named the
 * path. The revision record is the side that saw the deletion, so its `deleted`
 * entries are merged in here — otherwise the reader could not see, let alone
 * restore, a file the session removed.
 *
 * A path the fold already lists keeps its entry: the record adds detail to that
 * row rather than a second one. Ordering is by `firstSeq` across both sources,
 * so a merged row lands where the session first touched it.
 * @param folded - the paths the change fold derived from the log.
 * @param recorded - one entry per path the Host recorded a revision for.
 * @returns the union, in first-seen order.
 */
export function withRecordedDeletions(
  folded: readonly SessionChange[],
  recorded: ReadonlyMap<string, RecordedInfo>,
): readonly SessionChange[] {
  const known = new Set(folded.map(change => change.path))
  const extra: SessionChange[] = []
  for (const [path, info] of recorded) {
    if (info.origin !== 'deleted' || known.has(path)) continue
    extra.push({ path, operation: 'delete', firstSeq: info.firstSeq, lastSeq: info.lastSeq })
  }
  if (extra.length === 0) return folded
  return [...folded, ...extra].sort((left, right) => left.firstSeq - right.firstSeq)
}

/** The folded list rendered from the store-owned accept record. */
export function SessionChangesPanel({
  changes, accepted, onAccept, onAcceptAll, openFile, cwd, onViewDiff, hasRevision,
  reverting, onRevertAll, onRevertOne, revertingPaths, recordedInfo, t,
}: SessionChangesPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [view, setView] = useState<ChangesView>('pending')
  const [openError, setOpenError] = useState<string | null>(null)
  // Reverting writes to disk irreversibly, so the bulk control opens a
  // confirmation instead of acting on the click that reached it.
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  // The dock is a one-line strip above the composer: a refused open reports
  // itself on the strip rather than through a dialog the strip cannot own.
  const open = (path: string): void => {
    void openFile(path).then(
      () => { setOpenError(null) },
      (error: unknown) => { setOpenError(error instanceof Error ? error.message : String(error)) },
    )
  }

  // Nothing was ever changed in this Session: the strip has no subject at all.
  if (changes.length === 0) return null
  const pending = pendingChanges(changes, accepted)
  const rows = view === 'pending' ? pending : changes
  // The bulk revert acts on what the Host recorded, not on what the list shows,
  // so its confirmation counts the recorded paths rather than the visible rows.
  const revertableCount = changes.filter(change => hasRevision(change.path)).length

  return (
    <section className={css.root} data-testid="session-changes" aria-label={t('title')}>
      <div className={css.headerRow}>
        <button
          type="button"
          className={css.header}
          aria-expanded={expanded}
          onClick={() => { setExpanded(value => !value) }}
        >
          <span className={css.lead} aria-hidden><IconEditOutline16 size={14} /></span>
          <span className={css.title}>{t('title')}</span>
          <span className={css.count}>
            {view === 'pending'
              ? t('summary', { count: pending.length })
              : t('summaryAll', { count: changes.length })}
          </span>
          <span className={css.chevron} aria-hidden>
            {expanded ? <IconChevronDownOutline14 /> : <IconChevronUpOutline14 />}
          </span>
        </button>
        {pending.length > 0 && (
          <button
            type="button"
            className={css.bulkAccept}
            onClick={() => { onAcceptAll(pending) }}
          >
            <IconCheckOutline16 size={14} />
            {t('acceptAll')}
          </button>
        )}
        {/* The bulk control reverts what the Host RECORDED, not what the list
            shows, so it is offered only while the recorded set covers at least
            one listed path. Otherwise it would promise "reverted 0 files". */}
        {onRevertAll !== undefined && revertableCount > 0 && (
          <button
            type="button"
            className={css.revertAll}
            onClick={() => { setAcknowledged(false); setConfirming(true) }}
            disabled={reverting === true}
            aria-label={t('revertAll')}
          >
            {reverting === true ? t('reverting') : t('revertAll')}
          </button>
        )}
      </div>
      <RiskConfirmation
        open={confirming}
        title={t('revertConfirmTitle')}
        description={t('revertConfirm', { count: revertableCount })}
        acknowledgeLabel={t('revertConfirmAcknowledge')}
        cancelLabel={t('revertConfirmCancel')}
        closeLabel={t('revertConfirmClose')}
        confirmLabel={t('revertConfirmAction')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setConfirming(false) }}
        onConfirm={() => {
          setConfirming(false)
          onRevertAll?.()
        }}
      />
      {expanded && (
        <>
          {/* Two readings of one list: the strip stays reachable after every
              file is accepted, because the all-view entry must not vanish
              with the pending rows. */}
          <div className={css.views} role="tablist" aria-label={t('title')}>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'pending'}
              className={css.viewTab}
              data-active={view === 'pending'}
              onClick={() => { setView('pending') }}
            >
              {t('view.pending')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'all'}
              className={css.viewTab}
              data-active={view === 'all'}
              onClick={() => { setView('all') }}
            >
              {t('view.all')}
            </button>
          </div>
          <ul className={css.list}>
            {rows.map((change) => {
              const shown = displayPath(change.path, cwd)
              const isPending = isPendingChange(change, accepted)
              const info = recordedInfo?.get(change.path)
              return (
                <li key={change.path} className={css.item}>
                  <button
                    type="button"
                    className={css.path}
                    // The absolute path stays the hover text: it is the identity
                    // the fold and the opener use, and the row shows it shortened.
                    title={change.path}
                    aria-label={t('open', { name: shown })}
                    onClick={() => { open(change.path) }}
                  >
                    <span className={css.dirName}>{directoryOf(shown)}</span>
                    <span className={css.baseName}>{workspaceTitleOf(shown)}</span>
                  </button>
                  {/* Counts come from the Host's record, so a path without one
                      shows nothing rather than a misleading zero, and a deleted
                      path reports the deletion instead of two empty numbers. */}
                  {info !== undefined && (
                    info.origin === 'deleted' ? (
                      <span className={css.deleted} title={t('deletedHint')}>{t('deleted')}</span>
                    ) : (
                      <span className={css.lines}>
                        <span className={css.lineAdded}>{t('lineAdded', { count: info.added })}</span>
                        <span className={css.lineRemoved}>{t('lineRemoved', { count: info.removed })}</span>
                      </span>
                    )
                  )}
                  {/* Offered for EVERY row, recorded or not: a path the Host has no
                      revision for still opens a viewer that says so. Gating this on
                      the record made the whole control vanish for such a path, which
                      reads as "this feature is missing" rather than "this file has no
                      recorded change" — the reader cannot tell the two apart. */}
                  {onViewDiff !== undefined && (
                    <button
                      type="button"
                      className={css.iconAction}
                      onClick={() => { onViewDiff(change) }}
                      aria-label={t('viewChanges')}
                      title={t('viewChanges')}
                    >
                      <IconEyeOutline16 size={14} />
                    </button>
                  )}
                  {isPending ? (
                    <button
                      type="button"
                      className={clsx(css.iconAction, css.accept)}
                      onClick={() => { onAccept(change) }}
                      aria-label={t('accept')}
                      title={t('accept')}
                    >
                      <IconCheckOutline16 size={14} />
                    </button>
                  ) : (
                    <span className={css.accepted}>{t('accepted')}</span>
                  )}
                  {/* Offered only where the Host recorded a revision: a revert
                      targets a recorded path, so a row without one would open a
                      control that can only fail. */}
                  {onRevertOne !== undefined && hasRevision(change.path) && (
                    <button
                      type="button"
                      className={clsx(css.iconAction, css.revert)}
                      onClick={() => { onRevertOne(change) }}
                      // One path's revert in flight does not disable another
                      // path's: the two touch different files.
                      disabled={revertingPaths?.has(change.path) === true}
                      aria-label={t('revertOne')}
                      title={`${t('revertOne')} — ${t('revertOneHint', { name: shown })}`}
                    >
                      <IconUndoOutline16 size={14} />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {openError !== null && (
        <p className={css.openError} role="alert">{t('openFailed', { message: openError })}</p>
      )}
    </section>
  )
}

/**
 * Dock adapter: reads the whole-log projection (falling back to the loaded
 * window) and writes accepts into the session-scoped store.
 */
export function SessionChangesDock({
  useConversation, useProjection, useStore, actions, sessionId, cwd, openFile, revisions,
  openViewer, t,
}: SessionChangesDockProps) {
  const projected = useProjection('changedFiles')
  const revisionsRef = revisions
  const conversation = useConversation(snapshot => snapshot)
  // The projection is the whole-log answer; the window fold is the fallback for
  // a composition that mounts no projection registry. Both produce the same
  // shape, so nothing downstream knows which one answered.
  const folded = useMemo(
    () => projected === undefined ? sessionChanges(conversation, cwd) : projected.files,
    [projected, conversation, cwd],
  )
  // The accept record lives in the session-scoped store, not on this component:
  // a new user request adds turns to the timeline without remounting the dock,
  // but a rebind (reload, or switching Sessions and back) would otherwise drop
  // every prior accept and resurrect the whole list. The store also persists,
  // so the record outlives the page.
  const accepted = useStore(state => state)
  const accept = useCallback((change: SessionChange): void => {
    // The row that calls this disappears once its path is accepted, so no
    // second call for one path can reach the store.
    /* v8 ignore next -- an accepted path is dropped from the pending list that sources this call. */
    if (accepted[change.path] === change.lastSeq) return
    actions.accept(change.path, change.lastSeq)
  }, [accepted, actions])
  const acceptAll = useCallback((changes: readonly SessionChange[]): void => {
    actions.acceptMany(changes)
  }, [actions])
  // Which paths the Host actually recorded a revision for, plus what each
  // record says about its line counts and origin. The changed-file list is
  // folded from the durable log while the revision record lives on the Host's
  // own side, so the two disagree for paths the list knows and the record does
  // not — offering the controls there would promise an action that cannot be
  // answered. The map is refetched after a revert because a successful one
  // retires its path.
  const [recorded, setRecorded] = useState<ReadonlyMap<string, RecordedInfo>>(() => new Map())
  const refreshRecorded = useCallback((): void => {
    if (revisionsRef === undefined) return
    void revisionsRef.list(sessionId).then(
      (entries) => {
        setRecorded(new Map(entries.map(entry => [entry.path, {
          added: entry.added,
          removed: entry.removed,
          origin: entry.origin,
          firstSeq: entry.firstSeq,
          lastSeq: entry.lastSeq,
        }])))
      },
      () => { setRecorded(new Map()) },
    )
  }, [revisionsRef, sessionId])
  // Refetch when the change list grows, not only on mount: the agent mutates
  // files while the dock stays mounted, and the Host records each as it lands.
  // A mount-only read would leave a newly changed file without its controls
  // until the reader reloaded the page — which is the ordinary case, since the
  // reader is watching the session the agent is working in.
  //
  // The dependency is the NUMBER of changes rather than the list reference:
  // the projection rebuilds its array on every conversation change, so keying
  // on the reference would refetch on each one.
  const changeCount = folded.length
  useEffect(() => { refreshRecorded() }, [refreshRecorded, changeCount])
  // The record contributes paths the log cannot show — a file a shell command
  // deleted is named by no write call — so the rows are the union of both.
  const changes = useMemo(
    () => withRecordedDeletions(folded, recorded),
    [folded, recorded],
  )
  // The revert's progress and outcome are this mount's own business: nothing
  // about an in-flight or finished revert has to survive a reload, and a
  // restored flag would disable the control with no operation behind it.
  //
  // Progress is a SET of paths rather than one flag: a per-file revert touches
  // one file, so one path's revert in flight must not disable another row's.
  const [revertingPaths, setRevertingPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [summary, setSummary] = useState<RevertSummary | null>(null)
  const [revertError, setRevertError] = useState<string | null>(null)
  const [revertedOne, setRevertedOne] = useState<string | null>(null)
  /** Run one revert, tracking only its own path as in flight. */
  const runRevert = useCallback((path: string | undefined, onDone: (results: readonly RevertFileResult[]) => void): void => {
    // The narrowing both callers already made; kept here because this is the
    // function that dereferences the Remote.
    /* v8 ignore next -- both callers are wired only when the Remote exists. */
    if (revisionsRef === undefined) return
    const key = path ?? ALL_PATHS
    setRevertingPaths(current => new Set(current).add(key))
    setSummary(null)
    setRevertError(null)
    setRevertedOne(null)
    void revisionsRef.revert(sessionId, path).then(
      (results) => {
        setRevertingPaths((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
        onDone(results)
        refreshRecorded()
      },
      (error: unknown) => {
        setRevertingPaths((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
        setRevertError(revisionFailureText(error, t, 'revertFailed'))
      },
    )
  }, [revisionsRef, sessionId, refreshRecorded, t])
  const revertAll = useCallback((): void => {
    runRevert(undefined, (results) => { setSummary(summarize(results)) })
  }, [runRevert])
  // A single-file revert answers for one path, so its outcome is per path rather
  // than the batch summary: a conflict sentence counts files, which would say
  // nothing useful about the one the reader just acted on. The Host reports one
  // result for the one path asked about — a path it has no record for fails the
  // call outright — so there is nothing to pick from.
  const revertOne = useCallback((change: SessionChange): void => {
    runRevert(change.path, (results) => {
      const result = results[0]
      // The Host answers a single-path revert with exactly one result, or fails
      // the call; the guard exists only because indexing an array is typed
      // optional.
      /* v8 ignore next -- a single-path revert settles with one result. */
      if (result === undefined) return
      if (result.status === 'reverted') {
        setRevertedOne(change.path)
        return
      }
      const blocked = revertBlockedText(result, t)
      if (blocked !== null) {
        setRevertError(blocked)
        return
      }
      setSummary(summarize(results))
    })
  }, [runRevert, t])
  const hasRevision = useCallback((path: string): boolean => recorded.has(path), [recorded])
  return (
    <>
      <SessionChangesPanel
        changes={changes}
        accepted={accepted}
        onAccept={accept}
        onAcceptAll={acceptAll}
        openFile={openFile}
        cwd={cwd}
        onViewDiff={revisionsRef === undefined ? undefined : (change) => {
          openViewer({ sessionId, path: change.path, fileCount: changes.length })
        }}
        hasRevision={hasRevision}
        reverting={revertingPaths.has(ALL_PATHS)}
        onRevertAll={revisionsRef === undefined ? undefined : revertAll}
        onRevertOne={revisionsRef === undefined ? undefined : revertOne}
        revertingPaths={revertingPaths}
        recordedInfo={recorded}
        t={t}
      />
      {revertError !== null && (
        <p className={css.openError} role="alert">{revertError}</p>
      )}
      {revertError === null && revertedOne !== null && (
        <p className={css.revertDone} role="status">
          {t('revertOneDone', { name: workspaceTitleOf(revertedOne) })}
        </p>
      )}
      {revertError === null && revertedOne === null && summary !== null && summary.conflicts > 0 && (
        <p className={css.openError} role="alert">{t('revertConflict', { count: summary.conflicts })}</p>
      )}
      {revertError === null && revertedOne === null && summary !== null && summary.conflicts === 0 && (
        <p className={css.revertDone} role="status">{t('revertDone', { count: summary.reverted })}</p>
      )}
    </>
  )
}
