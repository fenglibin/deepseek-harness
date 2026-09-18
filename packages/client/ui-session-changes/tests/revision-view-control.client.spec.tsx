// @vitest-environment jsdom
/**
 * The revision controls through a REAL Session log and the REAL `changedFiles`
 * projection unit.
 *
 * Every other dock spec feeds the component a hand-built projection; this one
 * proves the control gating behaves as designed against the projection's own
 * output. The case that matters is the one the field hit: the Host records no
 * revision for ANY path, which is the ordinary state of a Session whose
 * captures never landed. Hiding the viewer there made the whole action look
 * absent, so the eye must stay on every row, publish a request on click, while
 * revert — which writes to disk — stays hidden.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as FileChangesPlugin from '@deepseek-ai/dsh-file-changes'
import type { ChangedFilesProjection } from '@deepseek-ai/dsh-file-changes/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionChangesDock } from '../src/client/SessionChangesDock.tsx'
import { createAcceptedChangesStore } from '../src/client/accept-store.ts'
import { zh } from '../src/client/locales.ts'
import type { RevisionViewerRequest } from '../src/client/revision-viewer-request.ts'
import '@deepseek-ai/dsh-client-ui-session-changes/client'

const t: Parameters<typeof SessionChangesDock>[0]['t'] = makeTranslate(zh, commonZh)
afterEach(cleanup)

function mutate(session: Session, turnNumber: number, callId: string, path: string): void {
  const call = session.append('tool/call', {
    turn: turnNumber, step: 1, callId: ToolCallId(callId), name: 'write',
    arguments: JSON.stringify({ file_path: path, content: 'x' }),
  })
  session.append('tool/result', {
    turn: turnNumber,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId), content: [{ type: 'text', text: 'ok' }], isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

function turn(session: Session, n: number, body: () => void): void {
  session.append('turn/start', { turn: n })
  session.append('step/start', { turn: n, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${String(n)}` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  body()
  session.append('step/end', { turn: n, step: 1 })
  session.append('turn/end', { turn: n, reason: { kind: 'completed' } })
}

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

describe('row controls over a real changed-files projection', () => {
  it('keeps the eye on every row while the Host records nothing, hides revert, drops the operation label', async () => {
    const { ctx, session, read } = await composed('selfcheck')
    turn(session, 1, () => {
      mutate(session, 1, 'w-a', 'src/a.txt')
      mutate(session, 1, 'w-b', 'src/b.txt')
    })
    // 守卫：投影真的返回两个文件，否则下面的断言说的是空列表。
    expect(read()?.files).toHaveLength(2)

    const opened: RevisionViewerRequest[] = []
    const seat = createAcceptedChangesStore().create('selfcheck')
    const props = {
      useConversation: () => ({ views: { get: () => undefined } }) as never,
      useProjection: () => read(),
      useStore: bindSnapshotSelector(seat),
      actions: seat.actions,
      sessionId: 'selfcheck',
      cwd: '/proj',
      openFile: async () => {},
      revisions: { list: async () => [], diff: async () => { throw new Error('unused') }, revert: async () => [] },
      openViewer: (r: RevisionViewerRequest) => { opened.push(r) },
      t,
      session: {} as never,
      input: {} as never,
    } as unknown as Parameters<typeof SessionChangesDock>[0]

    render(<SessionChangesDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('title')) }))

    const eyes = screen.getAllByRole('button', { name: zh['viewChanges'] })
    expect(eyes).toHaveLength(2)
    expect(screen.queryByRole('button', { name: zh['revertOne'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['revertAll'] })).toBeNull()
    expect(screen.queryByText('写入')).toBeNull()
    expect(screen.queryByText('修改')).toBeNull()

    fireEvent.click(eyes[0] as HTMLElement)
    expect(opened).toEqual([{ sessionId: 'selfcheck', path: '/proj/src/a.txt', fileCount: 2 }])
    // 先卸载组件再拆装配：反序会让仍在挂载的 useProjection 读到已注销的服务。
    cleanup()
    await ctx.fiber.dispose()
  })
})
