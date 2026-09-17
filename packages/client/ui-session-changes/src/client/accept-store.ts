/**
 * The dock's session-scoped view state: the accepted seq per path, whether a
 * revert is running, and what the last revert did.
 *
 * The record outlives the dock component on purpose. Component-local state is
 * cleared whenever the entry's scope rebinds (a page reload, or switching to
 * another session and back), which would resurrect EVERY accepted file rather
 * than only those the agent changed again. The store seat gives the record the
 * session's lifetime, and the persist key gives it the browser's.
 *
 * @module @deepseek-ai/dsh-client-ui-session-changes/client/accept-store
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { RevertFileResult } from '@deepseek-ai/dsh-api-session-file-revisions/types'

/**
 * Accepted seq per canonical path. A path's entry is the `lastSeq` the reader
 * saw when they accepted it; the path is pending again once the list shows a
 * later `lastSeq`.
 */
export type AcceptedChanges = Readonly<Record<string, number>>

/**
 * What the last revert did, as counts. Kept as a shape rather than a sentence
 * because the copy belongs to the locale, and the store has no locale seat.
 */
export interface RevertSummary {
  /** Paths whose content was restored. */
  readonly reverted: number
  /** Paths whose changes had been overwritten, so nothing was reverted. */
  readonly conflicts: number
}

/** Store state: the accepted record alone, which is what persists. */
type AcceptedChangesState = Record<string, number>

/** Declared write set of the accept record. */
type AcceptedChangesActions = {
  /** Record one path as accepted at the seq the reader saw. */
  accept: (draft: AcceptedChangesState, path: string, seq: number) => void
  /** Record every given path at its own accepted seq. */
  acceptMany: (
    draft: AcceptedChangesState,
    changes: readonly { readonly path: string; readonly lastSeq: number }[],
  ) => void
}

/** Store state of one revert: progress, outcome, and failure. */
export interface RevertState {
  /** True while a revert is in flight. */
  readonly reverting: boolean
  /** The last revert's outcome, or null when there has been none. */
  readonly summary: RevertSummary | null
  /** Failure text when the revert itself failed. */
  readonly error: string | null
}

/** Persist key prefix; the framework suffixes the session id so sessions stay independent. */
export const ACCEPTED_CHANGES_PERSIST_KEY = 'dsh.session-changes.accepted'

/**
 * Declare the session-scoped, persisted accept record.
 *
 * The store owns only the accepted seq per path; the revert verbs stay with the
 * component, which resolves them from the injected Remote face.
 * @returns the store handle registered on the changed-files dock entry.
 */
export function createAcceptedChangesStore(): EngineStoreHandle<AcceptedChangesState, AcceptedChangesActions> {
  return defineStore({
    init: (): AcceptedChangesState => ({}),
    persist: ACCEPTED_CHANGES_PERSIST_KEY,
    actions: {
      accept: (draft, path: string, seq: number) => {
        draft[path] = seq
      },
      acceptMany: (draft, changes: readonly { readonly path: string; readonly lastSeq: number }[]) => {
        for (const change of changes) draft[change.path] = change.lastSeq
      },
    },
  })
}

/**
 * Count one revert's outcomes by status.
 * @param results - one result per attempted path.
 * @returns how many paths were reverted and how many had been overwritten.
 */
export function summarize(results: readonly RevertFileResult[]): RevertSummary {
  return {
    reverted: results.filter(result => result.status === 'reverted').length,
    conflicts: results.filter(result => result.status === 'conflict').length,
  }
}
