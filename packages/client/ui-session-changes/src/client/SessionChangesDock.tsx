/**
 * SessionChangesDock: the changed-files list docked above the message composer
 * (input dock strip). It folds the per-turn `deliverables` vocabulary — the
 * successful `write` / `edit` / `str_replace_editor` mutations the agent made
 * this session — into one session-wide, first-seen list, shows each file's
 * full path as an openable row, and lets the user accept a file to clear it
 * from the list. Accepting changes nothing on disk; it is a surface-only
 * dismissal. Reject is deliberately out of scope (no per-call prior-content
 * snapshot exists to roll a file back).
 */

import { useCallback, useMemo, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the `deliverables` ConversationTurnDataMap key merge and its
// mutation operation kind. Type imports are erased, so the shared vocabulary
// reaches this plugin without a cross-plugin value import.
import type { MutationOperation } from '@deepseek-ai/dsh-client-ui-deliverables/client'
// Type-only: the `chat` ConversationViewSnapshotMap key merge, so
// `conversation.views.get('chat')` resolves to the chat snapshot with its timeline.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { resolveWorkspacePath, workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronUpOutline14, IconEditOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SessionChangesDock.module.css'

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

/** One session change: the produced path plus its user-visible operation kind. */
export interface ProducedChange {
  readonly path: string
  readonly operation: MutationOperation
}

/**
 * Canonical spelling of one mutation path: resolved against the Session
 * Workspace root, with both separators unified to `/` and empty, `.`, and
 * `..` segments collapsed. A Windows drive prefix survives verbatim.
 * Two calls naming the same file with different spellings — once absolute,
 * once Workspace-relative — yield one key, which is what keeps a file from
 * being listed twice.
 * @param path - path exactly as the tool call spelled it.
 * @param cwd - Session Workspace root; absent leaves a relative path relative.
 * @returns the canonical path.
 */
export function canonicalMutationPath(path: string, cwd: string | undefined): string {
  const resolved = resolveWorkspacePath(cwd, path)
  const kept: string[] = []
  for (const segment of resolved.split(/[/\\]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && kept.length > 0 && kept[kept.length - 1] !== '..') {
      kept.pop()
      continue
    }
    kept.push(segment)
  }
  return (resolved.startsWith('/') ? '/' : '') + kept.join('/')
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
 * @param conversation - the current Session's assembled Conversation snapshot.
 * @param cwd - Session Workspace root used to canonicalize relative paths.
 * @returns the session's produced changes in first-seen order.
 */
export function sessionChanges(conversation: ConversationSnapshot, cwd?: string): readonly ProducedChange[] {
  const chat = conversation.views.get('chat')
  if (chat === undefined) return []
  const seen = new Map<string, MutationOperation>()
  for (const turn of chat.timeline.turns.values()) {
    const deliverables = turn.data.get('deliverables')
    if (deliverables === undefined) continue
    for (const produced of deliverables.produced) {
      const path = canonicalMutationPath(produced.path, cwd)
      if (!seen.has(path)) seen.set(path, produced.operation)
    }
  }
  return [...seen.entries()].map(([path, operation]) => ({ path, operation }))
}

/** Props of the pure list panel: the folded changes plus the locale seat. */
export type SessionChangesPanelProps = {
  changes: readonly ProducedChange[]
  /** Per-file accept set, owned by the dock adapter so it survives a new request. */
  accepted: ReadonlySet<string>
  /** Record one file's accept; the adapter keeps the canonical set. */
  onAccept: (path: string) => void
  /** Mark every pending file accepted. */
  onAcceptAll: (paths: readonly string[]) => void
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

  const pending = changes.filter(change => !accepted.has(change.path))
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
          onClick={() => { onAcceptAll(pending.map(change => change.path)) }}
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
                  onClick={() => { onAccept(change.path) }}
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

/** Dock adapter: owns the accept set so a new request keeps prior accepts. */
export function SessionChangesDock({ useConversation, cwd, openFile, t }: SessionChangesDockProps) {
  const conversation = useConversation(snapshot => snapshot)
  const changes = useMemo(() => sessionChanges(conversation, cwd), [conversation, cwd])
  // The accept set lives on the adapter, not the panel: a new user request
  // adds new turns to the timeline without unmounting the dock, but a
  // panel that returns null while pending is empty would otherwise drop the
  // accepted set on the next mount. Keeping it here means the user's prior
  // accepts persist across every render of the same dock registration.
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(() => new Set())
  const accept = useCallback((path: string): void => {
    setAccepted((previous) => {
      // The row that calls this disappears once its path is accepted, so no
      // second call for one path can reach the fold.
      /* v8 ignore next -- an accepted path is dropped from the pending list that sources this call. */
      if (previous.has(path)) return previous
      const next = new Set(previous)
      next.add(path)
      return next
    })
  }, [])
  const acceptAll = useCallback((paths: readonly string[]): void => {
    setAccepted((previous) => {
      let next: Set<string> | null = null
      for (const path of paths) {
        /* v8 ignore next -- every path handed here is pending, hence absent from the accepted set. */
        if (previous.has(path)) continue
        if (next === null) next = new Set(previous)
        next.add(path)
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
