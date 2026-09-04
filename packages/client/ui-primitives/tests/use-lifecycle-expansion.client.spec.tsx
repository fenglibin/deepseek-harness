// @vitest-environment jsdom
/** The lifecycle-driven disclosure primitive as observable row behavior. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useLifecycleExpansion } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

function Row({ running, restingExpanded }: { running: boolean; restingExpanded?: boolean }) {
  const [expanded, toggle] = useLifecycleExpansion({ running, restingExpanded })
  return (
    <button type="button" aria-expanded={expanded} onClick={toggle}>row</button>
  )
}

const expandedOf = (view: ReturnType<typeof render>): string | null =>
  view.getByRole('button').getAttribute('aria-expanded')

describe('useLifecycleExpansion', () => {
  it('opens while running and folds back to the resting state on settlement', () => {
    const view = render(<Row running />)
    expect(expandedOf(view)).toBe('true')
    view.rerender(<Row running={false} />)
    expect(expandedOf(view)).toBe('false')
  })

  it('stays open across the re-renders of a still-running operation', () => {
    const view = render(<Row running />)
    view.rerender(<Row running />)
    expect(expandedOf(view)).toBe('true')
  })

  it('keeps a row whose resting state is open open across settlement', () => {
    // An ask-user transcript appears together with settlement; the resting
    // value has to win over the collapse.
    const view = render(<Row running />)
    expect(expandedOf(view)).toBe('true')
    view.rerender(<Row running={false} restingExpanded />)
    expect(expandedOf(view)).toBe('true')
  })

  it('starts at the resting value when it mounts already settled', () => {
    // Every replayed history row mounts settled, so this is the shape a reader
    // scrolling back through a transcript sees.
    const closed = render(<Row running={false} />)
    expect(expandedOf(closed)).toBe('false')
    cleanup()
    const open = render(<Row running={false} restingExpanded />)
    expect(expandedOf(open)).toBe('true')
  })

  it('a reader toggle survives the renders around it', () => {
    // Only the running -> settled transition moves the state, so a reader who
    // reopens a finished row keeps it open instead of having it snatched shut.
    const view = render(<Row running={false} />)
    fireEvent.click(view.getByRole('button'))
    expect(expandedOf(view)).toBe('true')
    view.rerender(<Row running={false} restingExpanded />)
    expect(expandedOf(view)).toBe('true')
  })
})
