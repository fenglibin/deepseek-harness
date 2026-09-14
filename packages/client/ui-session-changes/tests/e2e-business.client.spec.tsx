// @vitest-environment jsdom

/**
 * End-to-end business check: a REAL Session log, folded by the REAL
 * `changedFiles` projection unit, driving the REAL dock component through the
 * whole accept story. Every other dock test feeds the component a hand-built
 * projection value; this one proves the unit's own output — seq bounds,
 * ordering, canonical paths — is actually the shape the business rules need.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as FileChangesPlugin from '@deepseek-ai/dsh-file-changes'
import type { ChangedFilesProjection } from '@deepseek-ai/dsh-file-changes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionChangesDock } from '../src/client/SessionChangesDock.tsx'
import { zh } from '../src/client/locales.ts'
// Type-only: registers the `session-changes` LocaleNamespaceMap merge so the
// dock's PropsLocale resolves `t` in this program.
import '@deepseek-ai/dsh-client-ui-session-changes/client'

type SessionHandle = Session
const t: Parameters<typeof SessionChangesDock>[0]['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

/** One successful mutation of `path`, recorded the way the agent loop records it. */
function mutate(session: SessionHandle, turn: number, callId: string, path: string, name = 'write'): void {
  const args = name === 'write'
    ? { file_path: path, content: 'x' }
    : { file_path: path, old_string: 'x', new_string: 'y' }
  const call = session.append('tool/call', {
    turn, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify(args),
  })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

/** Open and close one turn, so the log carries the boundaries the fold reads. */
function turn(session: SessionHandle, turnNumber: number, body: () => void): void {
  session.append('turn/start', { turn: turnNumber })
  session.append('step/start', { turn: turnNumber, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${String(turnNumber)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  body()
  session.append('step/end', { turn: turnNumber, step: 1 })
  session.append('turn/end', { turn: turnNumber, reason: { kind: 'completed' } })
}

/** A real Session on a real projection registry, plus a live projection reader. */
async function composed(id: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FileChangesPlugin)
  const session = Session.create(SessionId(id), undefined, {
    version: 0, id: SessionId(id), createdAt: 0, cwd: '/proj',
  })
  const read = (): ChangedFilesProjection | undefined =>
    ctx.sessionProjections.snapshot(session).values.changedFiles
  return { ctx, session, read }
}

/** Dock props reading the live projection, with no assembled chat view behind it. */
function dockProps(
  read: () => ChangedFilesProjection | undefined,
  openFile: () => Promise<void>,
): Parameters<typeof SessionChangesDock>[0] {
  return {
    useConversation: () => ({ views: { get: () => undefined } }) as never,
    useProjection: () => read(),
    cwd: '/proj',
    openFile,
    t,
    // The slot's owner share; the dock does not read it in any path exercised
    // here, so a stand-in keeps the props honest about their real shape.
    session: {} as never,
    input: {} as never,
  } as unknown as Parameters<typeof SessionChangesDock>[0]
}

describe('end-to-end business: a real log drives the dock', () => {
  it('keeps a change pending until accepted, then restores it when the file changes again', async () => {
    const { session, read } = await composed('e2e-business')
    const openFile = vi.fn<() => Promise<void>>(() => Promise.resolve())

    // Turn 1: the agent creates src/a.txt and src/b.txt.
    turn(session, 1, () => {
      mutate(session, 1, 'w-a', 'src/a.txt')
      mutate(session, 1, 'w-b', 'src/b.txt')
    })

    // Guard: the projection really returned two files, so the dock's count is
    // evidence about the unit rather than about an empty list.
    expect(read()?.files).toHaveLength(2)
    const view = render(<SessionChangesDock {...dockProps(read, openFile)} />)
    expect(screen.getByText(t('summary', { count: 2 }))).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('title')) }))
    // The path is canonicalized against the Session Workspace root.
    expect(screen.getByTitle('/proj/src/a.txt')).toBeDefined()

    // Accepting a.txt leaves b.txt pending and touches no file on disk: the
    // dock's only channel to the Host is its opener, and it stays unused.
    fireEvent.click(screen.getAllByRole('button', { name: t('accept') })[0]!)
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
    expect(openFile).not.toHaveBeenCalled()

    // Turn 2 adds an untouched file: the accept survives the new turn and the
    // accepted file stays hidden.
    turn(session, 2, () => { mutate(session, 2, 'w-c', 'src/c.txt') })
    view.rerender(<SessionChangesDock {...dockProps(read, openFile)} />)
    expect(screen.getByText(t('summary', { count: 2 }))).toBeDefined()

    // Turn 3 edits a.txt again: the accepted file comes back to the list.
    turn(session, 3, () => { mutate(session, 3, 'e-a', 'src/a.txt', 'edit') })
    view.rerender(<SessionChangesDock {...dockProps(read, openFile)} />)
    expect(screen.getByText(t('summary', { count: 3 }))).toBeDefined()
    expect(screen.getByTitle('/proj/src/a.txt')).toBeDefined()
  })

  it('accept-all hides every pending file and only a later change brings one back', async () => {
    const { session, read } = await composed('e2e-accept-all')
    const openFile = vi.fn<() => Promise<void>>(() => Promise.resolve())

    turn(session, 1, () => {
      mutate(session, 1, 'w-a', 'src/a.txt')
      mutate(session, 1, 'w-b', 'src/b.txt')
    })

    const view = render(<SessionChangesDock {...dockProps(read, openFile)} />)
    fireEvent.click(screen.getByRole('button', { name: t('acceptAll') }))
    expect(screen.queryByTestId('session-changes')).toBeNull()

    // A later edit of b.txt restores only b.txt.
    turn(session, 2, () => { mutate(session, 2, 'e-b', 'src/b.txt', 'edit') })
    view.rerender(<SessionChangesDock {...dockProps(read, openFile)} />)
    expect(screen.getByText(t('summary', { count: 1 }))).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('title')) }))
    expect(screen.getByTitle('/proj/src/b.txt')).toBeDefined()
  })

  it('lists the whole Session regardless of how much history the client loaded', async () => {
    const { session, read } = await composed('e2e-window')

    // Many turns, each changing one file: a client that loaded only the tail
    // window would see a fraction of these.
    for (let index = 1; index <= 6; index += 1) {
      const file = `src/f${String(index)}.txt`
      turn(session, index, () => { mutate(session, index, `w-${String(index)}`, file) })
    }

    // There is no assembled chat view at all here, so the window fallback would
    // show nothing — the dock still shows every changed file.
    render(<SessionChangesDock {...dockProps(read, () => Promise.resolve())} />)
    expect(screen.getByText(t('summary', { count: 6 }))).toBeDefined()
  })
})
