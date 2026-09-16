/**
 * The dock's accept record: one accepted seq per canonical path, held by a
 * session-scoped store.
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

/**
 * Accepted seq per canonical path. A path's entry is the `lastSeq` the reader
 * saw when they accepted it; the path is pending again once the list shows a
 * later `lastSeq`.
 */
export type AcceptedChanges = Readonly<Record<string, number>>

/** Store state: the same record as mutable, which is what an immer draft edits. */
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

/** Persist key prefix; the framework suffixes the session id so sessions stay independent. */
export const ACCEPTED_CHANGES_PERSIST_KEY = 'dsh.session-changes.accepted'

/**
 * Declare the session-scoped, persisted accept record.
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
