/**
 * SessionChangesDock: the changed-files list docked above the message composer
 * (input dock strip). It folds the per-turn `deliverables` vocabulary — the
 * successful `write` / `edit` / `str_replace_editor` mutations the agent made
 * this session — into one session-wide, first-seen list, and lets the user
 * accept a file to clear it from the list. Accepting changes nothing on disk;
 * it is a surface-only dismissal. Reject is deliberately out of scope (no
 * per-call prior-content snapshot exists to roll a file back).
 */

import { useCallback, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the `deliverables` ConversationTurnDataMap key merge and its
// mutation operation kind. Type imports are erased, so the shared vocabulary
// reaches this plugin without a cross-plugin value import.
import type { MutationOperation } from '@deepseek-ai/dsh-client-ui-deliverables/client'
// Type-only: the `chat` ConversationViewSnapshotMap key merge, so
// `conversation.views.get('chat')` resolves to the chat snapshot with its timeline.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronUpOutline14, IconEditOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SessionChangesDock.module.css'

/** Full props of the dock entry: session standard kit (`useConversation`) + the locale seat. */
export type SessionChangesDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'session-changes'>

/** One session change: the produced path plus its user-visible operation kind. */
export interface ProducedChange {
  readonly path: string
  readonly operation: MutationOperation
}

/**
 * Fold every turn's produced changes into one session-wide first-seen list.
 * A file written and then edited this session stays one entry, with the
 * earliest operation kind. `useConversation` returns a stable reference until
 * the conversation changes, so the memo re-runs only on new material.
 * @param conversation - the current Session's assembled Conversation snapshot.
 * @returns the session's produced changes in first-seen order.
 */
export function sessionChanges(conversation: ConversationSnapshot): readonly ProducedChange[] {
  const chat = conversation.views.get('chat')
  if (chat === undefined) return []
  const seen = new Map<string, MutationOperation>()
  for (const turn of chat.timeline.turns.values()) {
    const deliverables = turn.data.get('deliverables')
    if (deliverables === undefined) continue
    for (const produced of deliverables.produced) {
      if (!seen.has(produced.path)) seen.set(produced.path, produced.operation)
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
} & PropsLocale<'session-changes'>

/** The folded list rendered from the adapter-owned accept set. */
export function SessionChangesPanel({ changes, accepted, onAccept, onAcceptAll, t }: SessionChangesPanelProps) {
  const [expanded, setExpanded] = useState(false)

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
          {pending.map(change => (
            <li key={change.path} className={css.item}>
              <span className={css.path} title={change.path}>{workspaceTitleOf(change.path)}</span>
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
          ))}
        </ul>
      )}
    </section>
  )
}

/** Dock adapter: owns the accept set so a new request keeps prior accepts. */
export function SessionChangesDock({ useConversation, t }: SessionChangesDockProps) {
  const conversation = useConversation(snapshot => snapshot)
  const changes = useMemo(() => sessionChanges(conversation), [conversation])
  // The accept set lives on the adapter, not the panel: a new user request
  // adds new turns to the timeline without unmounting the dock, but a
  // panel that returns null while pending is empty would otherwise drop the
  // accepted set on the next mount. Keeping it here means the user's prior
  // accepts persist across every render of the same dock registration.
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(() => new Set())
  const accept = useCallback((path: string): void => {
    setAccepted((previous) => {
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
        if (previous.has(path)) continue
        if (next === null) next = new Set(previous)
        next.add(path)
      }
      return next ?? previous
    })
  }, [])
  return (
    <SessionChangesPanel
      changes={changes}
      accepted={accepted}
      onAccept={accept}
      onAcceptAll={acceptAll}
      t={t}
    />
  )
}
