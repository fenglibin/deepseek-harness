import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Options for {@link useLifecycleExpansion}.
 */
export interface LifecycleExpansionOptions {
  /** Whether the row's operation is still running. */
  running: boolean
  /**
   * The row's resting state: the expanded value a settled row falls back to.
   * A row that owns the answer (an ask-user transcript, a todo checklist)
   * passes `true` so settlement leaves it open.
   */
  restingExpanded?: boolean | undefined
}

/**
 * Disclosure state driven by one asynchronous operation's lifecycle: a running
 * row opens so the reader watches the result arrive, and settling folds it back
 * to its resting value instead of leaving a stale open row behind.
 *
 * Only the running -> settled transition moves the state, so a reader who
 * reopens a finished row keeps it open; a row that mounts already settled
 * (every replayed history row) starts at its resting value.
 * @param options.running - whether the operation is still running.
 * @param options.restingExpanded - expanded value a settled row falls back to.
 * @returns the current expanded state and a toggle that flips it.
 */
export function useLifecycleExpansion(
  { running, restingExpanded = false }: LifecycleExpansionOptions,
): readonly [boolean, () => void] {
  const [expanded, setExpanded] = useState(running || restingExpanded)
  const wasRunning = useRef(running)
  // The ref tracks the previous render's `running` so the effect fires on the
  // running -> settled transition alone. Reading the *current* `restingExpanded`
  // (not a ref) is what lets a row whose resting value appears together with
  // settlement — a just-answered ask-user row — stay open through it.
  useEffect(() => {
    if (wasRunning.current && !running) setExpanded(restingExpanded)
    wasRunning.current = running
  }, [running, restingExpanded])
  const toggle = useCallback(() => { setExpanded(value => !value) }, [])
  return [expanded, toggle] as const
}
