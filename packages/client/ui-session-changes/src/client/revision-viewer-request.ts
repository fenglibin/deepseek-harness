/**
 * The open request for the full-screen revision viewer.
 *
 * Its own module because both sides need the type and they must not import each
 * other's module: the dock (a session-scoped trigger) publishes requests, and the
 * `shell.overlay` occupant (a root-scoped carrier) renders them. The dock sits
 * inside a session and the viewer outside every session, so the request is what
 * crosses that boundary.
 *
 * @module @deepseek-ai/dsh-client-ui-session-changes/revision-viewer-request
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** One file the viewer was asked to show. */
export interface RevisionViewerRequest {
  /** Session whose cumulative change is shown. */
  readonly sessionId: string
  /** Canonical absolute path of the file to show. */
  readonly path: string
  /** How many files the session changed, for the header count. */
  readonly fileCount: number
}

/** The injected face the viewer occupant receives. */
export interface RevisionViewerInjected {
  hooks: {
    /** The file currently being viewed, or undefined while the viewer is closed. */
    request: HostObservable<RevisionViewerRequest | undefined>
  }
  /** Withdraw the current request, closing the viewer. */
  onClose: () => void
}

/** The observable plus its publisher, shared between the dock and the viewer. */
export interface RevisionViewerSource {
  /** The observable the viewer's hook binds to. */
  readonly requests: HostObservable<RevisionViewerRequest | undefined>
  /** Publish a request, or undefined to close. */
  readonly publish: (next: RevisionViewerRequest | undefined) => void
}

/**
 * Create the shared viewer request source.
 *
 * `getSnapshot` returns the identical value until a new request lands, which is
 * what the renderer's hook binding requires to avoid re-rendering on every read.
 * @returns the observable and its publisher.
 */
export function createRevisionViewerSource(): RevisionViewerSource {
  let current: RevisionViewerRequest | undefined
  const listeners = new Set<() => void>()
  return {
    requests: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    publish: (next) => {
      current = next
      for (const listener of listeners) listener()
    },
  }
}
