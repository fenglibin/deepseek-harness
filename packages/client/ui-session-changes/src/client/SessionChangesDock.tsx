/**
 * SessionChangesDock: the changed-files list docked above the message composer
 * (input dock strip). It shows every file the agent mutated in this Session and
 * lets the user accept a file to clear it from the list.
 *
 * The list's source is the host `changedFiles` projection, which folds the
 * COMPLETE durable log — a client that has paged in only the tail of a long
 * Session still sees every changed file. When that projection is absent (a
 * composition with no projection registry) the dock falls back to folding the
 * Turns the client has loaded, which is the same shape over a smaller window.
 *
 * Accepting changes nothing on disk; it is a surface-only dismissal. Accept is
 * remembered against the seq of the change the reader saw, so a file the agent
 * mutates again AFTER the accept returns to the list. Reject is deliberately out
 * of scope (no per-call prior-content snapshot exists to roll a file back).
 */

import { useCallback, useMemo, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
  IconCheckOutline16, IconChevronDownOutline14, IconChevronUpOutline14, IconEditOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SessionChangesDock.module.css'

export { canonicalMutationPath }

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
}

/** Full props of the dock entry: session standard kit (`useConversation`) + the injected opener + the locale seat. */
export type SessionChangesDockProps =
  PropsRuntime<'conversation.input.dock'> & InjectFace<SessionChangesInjected> & PropsLocale<'session-changes'>

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

/** Accept bookkeeping: one accepted `lastSeq` per path, owned by the dock adapter. */
export type AcceptedChanges = Readonly<Record<string, number>>

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
 * The changes still awaiting the reader's attention: every path whose latest
 * mutation is newer than the seq the reader accepted for it.
 *
 * A path with no accept at all is always pending; a path accepted at a seq the
 * list has since moved past is pending again. That single comparison is what
 * makes "accept, then the agent edits it again" put the file back.
 * @param changes - the Session's changed files, in first-seen order.
 * @param accepted - one accepted `lastSeq` per path.
 * @returns the pending changes, in the input's order.
 */
export function pendingChanges(
  changes: readonly SessionChange[],
  accepted: AcceptedChanges,
): readonly SessionChange[] {
  return changes.filter((change) => {
    const acceptedSeq = accepted[change.path]
    return acceptedSeq === undefined || change.lastSeq > acceptedSeq
  })
}

/** Props of the pure list panel: the folded changes plus the locale seat. */
export type SessionChangesPanelProps = {
  changes: readonly SessionChange[]
  /** Accepted `lastSeq` per path, owned by the dock adapter so it survives a new request. */
  accepted: AcceptedChanges
  /** Record one file's accept at the seq the reader saw. */
  onAccept: (change: SessionChange) => void
  /** Mark every pending file accepted at the seq the reader saw. */
  onAcceptAll: (changes: readonly SessionChange[]) => void
  /** Hand one changed file to the Host desktop opener; rejects when it refuses. */
  openFile: (path: string) => Promise<void>
  /** Session Workspace root; rows are spelled relative to it. */
  cwd: string | undefined
} & PropsLocale<'session-changes'>

/** The folded list rendered from the adapter-owned accept set. */
export function SessionChangesPanel({
  changes, accepted, onAccept, onAcceptAll, openFile, cwd, t,
}: SessionChangesPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  // The dock is a one-line strip above the composer: a refused open reports
  // itself on the strip rather than through a dialog the strip cannot own.
  const open = (path: string): void => {
    void openFile(path).then(
      () => { setOpenError(null) },
      (error: unknown) => { setOpenError(error instanceof Error ? error.message : String(error)) },
    )
  }

  const pending = pendingChanges(changes, accepted)
  if (pending.length === 0) return null

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
          <span className={css.count}>{t('summary', { count: pending.length })}</span>
          <span className={css.chevron} aria-hidden>
            {expanded ? <IconChevronDownOutline14 /> : <IconChevronUpOutline14 />}
          </span>
        </button>
        <button
          type="button"
          className={css.bulkAccept}
          onClick={() => { onAcceptAll(pending) }}
        >
          <IconCheckOutline16 size={14} />
          {t('acceptAll')}
        </button>
      </div>
      {expanded && (
        <ul className={css.list}>
          {pending.map((change) => {
            const shown = displayPath(change.path, cwd)
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
                <span className={css.operation} data-operation={change.operation}>
                  {t(change.operation === 'write' ? 'operation.write' : 'operation.edit')}
                </span>
                <button
                  type="button"
                  className={css.accept}
                  onClick={() => { onAccept(change) }}
                  aria-label={t('accept')}
                >
                  <IconCheckOutline16 size={14} />
                  {t('accept')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {openError !== null && (
        <p className={css.openError} role="alert">{t('openFailed', { message: openError })}</p>
      )}
    </section>
  )
}

/**
 * Dock adapter: reads the whole-log projection (falling back to the loaded
 * window) and owns the accept set so a new request keeps prior accepts.
 */
export function SessionChangesDock({
  useConversation, useProjection, cwd, openFile, t,
}: SessionChangesDockProps) {
  const projected = useProjection('changedFiles')
  const conversation = useConversation(snapshot => snapshot)
  // The projection is the whole-log answer; the window fold is the fallback for
  // a composition that mounts no projection registry. Both produce the same
  // shape, so nothing downstream knows which one answered.
  const changes = useMemo(
    () => projected === undefined ? sessionChanges(conversation, cwd) : projected.files,
    [projected, conversation, cwd],
  )
  // The accept set lives on the adapter, not the panel: a new user request
  // adds new turns to the timeline without unmounting the dock, but a
  // panel that returns null while pending is empty would otherwise drop the
  // accepted set on the next mount. Keeping it here means the user's prior
  // accepts persist across every render of the same dock registration.
  const [accepted, setAccepted] = useState<AcceptedChanges>({})
  const accept = useCallback((change: SessionChange): void => {
    setAccepted((previous) => {
      // The row that calls this disappears once its path is accepted, so no
      // second call for one path can reach the fold.
      /* v8 ignore next -- an accepted path is dropped from the pending list that sources this call. */
      if (previous[change.path] === change.lastSeq) return previous
      return { ...previous, [change.path]: change.lastSeq }
    })
  }, [])
  const acceptAll = useCallback((changes: readonly SessionChange[]): void => {
    setAccepted((previous) => {
      let next: AcceptedChanges | null = null
      for (const change of changes) {
        /* v8 ignore next -- every change handed here is pending, hence not accepted at this seq. */
        if (previous[change.path] === change.lastSeq) continue
        next = { ...next ?? previous, [change.path]: change.lastSeq }
      }
      /* v8 ignore next -- the bulk button renders only while at least one file is pending. */
      return next ?? previous
    })
  }, [])
  return (
    <SessionChangesPanel
      changes={changes}
      accepted={accepted}
      onAccept={accept}
      onAcceptAll={acceptAll}
      openFile={openFile}
      cwd={cwd}
      t={t}
    />
  )
}
