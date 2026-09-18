/** Local submission echoes: synchronous insertion, observed/failed retirement, and settlement callbacks. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { Session } from '../src/client/sessions/session.ts'
import type { PendingSubmissionRetirement } from '../src/client/contract/session.ts'
import type { SessionQueuedItem, SessionRequestId } from '../src/types.ts'
import { FakeApiClient, err, fakeRemote, ok } from './fake-api.client.ts'
import { historyValue } from './event-script.client.ts'

const SID = 'fk-s1' as SessionId

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeSession(api = new FakeApiClient()): { api: FakeApiClient; session: Session } {
  return { api, session: new Session(SID, fakeRemote(api)) }
}

function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: id,
    mediaType: 'image/png',
    bytes: 1,
    width: 2,
    height: 2,
  } as unknown as ImageAttachmentRef
}

/** A durable browser-prompt user/message whose source echoes `rpcId`. */
function promptEvent(seq: number, rpcId: SessionRequestId, refs: readonly ImageAttachmentRef[] = []): SessionEvent {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'user/message',
    surfaceOp: 'append',
    data: createUserMessage({
      content: [
        ...refs.map(attachment => ({ type: 'image' as const, attachment })),
        { type: 'text' as const, text: '发送' },
      ],
      source: { kind: 'user', rpcId },
    }),
  } as unknown as SessionEvent
}

function queuedItem(rpcId: SessionRequestId, refs: readonly ImageAttachmentRef[] = []): SessionQueuedItem {
  return {
    id: 'm-queued' as SessionQueuedItem['id'],
    placement: 'queued',
    rpcId,
    message: {
      id: 'm-queued' as SessionQueuedItem['id'],
      content: refs.map(attachment => ({ type: 'image', attachment })) as unknown as SessionQueuedItem['message']['content'],
    },
  }
}

/** Let the frame-delayed retirement (setTimeout fallback in this node environment) run. */
function settleFrames(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('beginSubmission', () => {
  it('inserts the echo synchronously and flips the engaging edge before any prompt call', () => {
    const { session } = makeSession()
    expect(session.getSnapshot()).toMatchObject({ pendingSubmissions: [], promptAttempted: false })
    const handle = session.beginSubmission({
      text: '你好',
      images: [{ previewUrl: 'blob:p1', name: 'a.png', width: 4, height: 3 }],
    })
    expect(session.getSnapshot().promptAttempted).toBe(true)
    expect(session.getSnapshot().pendingSubmissions).toMatchObject([{
      requestId: handle.requestId,
      text: '你好',
      images: [{ previewUrl: 'blob:p1', name: 'a.png', width: 4, height: 3 }],
    }])
  })

  it('abandon retires the echo as failed exactly once', () => {
    const { session } = makeSession()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      text: '放弃',
      images: [],
      onRetire: retirement => retirements.push(retirement),
    })
    handle.abandon()
    handle.abandon()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'failed' }])
  })
})

describe('prompt-coupled retirement', () => {
  it('a rejected identified prompt retires its echo immediately alongside promptError', async () => {
    const { api, session } = makeSession()
    api.onPrompt = () => Promise.resolve(err(new RemoteError('session/agent-busy', '忙', { reason: 'busy' })))
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      text: '失败的',
      images: [],
      onRetire: retirement => retirements.push(retirement),
    })
    const result = await session.prompt([{ type: 'text', text: '失败的' }], 'queue', undefined, handle.requestId)
    expect(result.ok).toBe(false)
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send' })
    expect(retirements).toEqual([{ reason: 'failed' }])
  })

  it('sends the echo identity as the prompt requestId', async () => {
    const { api, session } = makeSession()
    const handle = session.beginSubmission({ text: '带 id', images: [] })
    await session.prompt([{ type: 'text', text: '带 id' }], 'queue', undefined, handle.requestId)
    expect(api.callsOf('session.prompt')).toMatchObject([{ requestId: handle.requestId }])
  })

  it('an unidentified prompt failure leaves registered echoes alone', async () => {
    const { api, session } = makeSession()
    api.onPrompt = () => Promise.resolve(err(new RemoteError('session/agent-busy', '忙', { reason: 'busy' })))
    session.beginSubmission({ text: '还在', images: [] })
    await session.prompt([{ type: 'text', text: '另一个' }], 'queue')
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
  })
})

describe('observed retirement', () => {
  it('a live durable event carrying the rpcId retires the echo one frame later with the admitted refs', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      text: '发送',
      images: [{ previewUrl: 'blob:p1' }],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('att-1')]
    await api.pushFollow(SID, { type: 'event', event: promptEvent(0, handle.requestId, refs) as never })
    // Synchronously after the append the echo is still in the snapshot; the
    // render-time dedupe owns the overlap frame.
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'observed', attachments: refs }])
  })

  it('keeps the echo while a queued occurrence is pending, then retires it on removal', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      text: '排队',
      images: [{ previewUrl: 'blob:p1' }],
      onRetire: retirement => retirements.push(retirement),
    })
    const refs = [imageRef('att-q')]
    session.handleControlFrame({ type: 'queue', sessionId: SID, items: [queuedItem(handle.requestId, refs)] })
    await settleFrames()
    // A queued row renders in the QueueDock, not the flow, so the echo keeps
    // standing in on the transcript until the durable user/message arrives.
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(retirements).toEqual([])
    // Removing the occurrence discards the prompt without a durable
    // counterpart, so the removal itself settles the echo.
    await session.updateQueue('m-queued' as never, { kind: 'remove' })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'removed' }])
  })

  it('retires a removed echo even when its queue frame lands before the RPC resolves', async () => {
    // The Host broadcasts the queue frame that drops the row, and that frame can
    // beat the RPC reply. Reading the projection after the call would then find
    // no row and leave the echo standing forever.
    const api = new FakeApiClient()
    const { session } = makeSession(api)
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      text: '先删后答',
      images: [],
      onRetire: retirement => retirements.push(retirement),
    })
    session.handleControlFrame({ type: 'queue', sessionId: SID, items: [queuedItem(handle.requestId)] })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    // Hold the reply open so the dropping frame can arrive first.
    let reply: (() => void) | undefined
    api.onUpdateQueue = () => new Promise((resolve) => {
      reply = () => { resolve(ok({ accepted: true as const })) }
    })
    const removing = session.updateQueue('m-queued' as never, { kind: 'remove' })
    session.handleControlFrame({ type: 'queue', sessionId: SID, items: [] })
    reply?.()
    await removing
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
    expect(retirements).toEqual([{ reason: 'removed' }])
  })

  it('keeps the echo when a queued occurrence is left unremoved after an unrelated queue action', async () => {
    // Only `remove` and `edit` settle the echo themselves; an occurrence that
    // keeps standing still reaches the log under the same rpcId, which then
    // retires the echo through the durable event.
    const { session } = makeSession()
    const handle = session.beginSubmission({ text: '编辑', images: [] })
    session.handleControlFrame({
      type: 'queue', sessionId: SID, items: [queuedItem(handle.requestId)],
    })
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
  })

  it('rewrites the echo content when its queued occurrence is edited', async () => {
    // An edit keeps the message identity, so the durable user/message that
    // eventually replaces this echo carries the NEW text. Leaving the echo alone
    // would keep the transcript showing what the user already changed.
    const { session } = makeSession()
    const handle = session.beginSubmission({ text: '原来的', images: [] })
    session.handleControlFrame({
      type: 'queue', sessionId: SID, items: [queuedItem(handle.requestId)],
    })
    await settleFrames()
    await session.updateQueue('m-queued' as never, {
      kind: 'edit',
      content: [{ type: 'text', text: '改过的' }],
    })
    const [echo] = session.getSnapshot().pendingSubmissions
    expect(echo?.text).toBe('改过的')
    expect(echo?.parts).toEqual([{ type: 'text', text: '改过的' }])
  })

  it('leaves a steered echo pending, because steering keeps the message pending on the Host', async () => {
    // `steer` moves the message into the running turn instead of discarding or
    // rewriting it, so the echo still retires on the durable event that follows.
    const { session } = makeSession()
    const handle = session.beginSubmission({ text: '插话', images: [] })
    session.handleControlFrame({
      type: 'queue', sessionId: SID, items: [queuedItem(handle.requestId)],
    })
    await settleFrames()
    await session.updateQueue('m-queued' as never, { kind: 'steer' })
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
  })

  it('a full-window install (reconnect resync) retires echoes observed in the window', async () => {
    const { api, session } = makeSession()
    const handle = session.beginSubmission({ text: '重连', images: [] })
    api.onHistory = () => Promise.resolve(ok(historyValue([promptEvent(12, handle.requestId)])))
    await session.open()
    await settleFrames()
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  it('the first observation wins: a later prompt failure cannot re-retire an observed echo', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      text: '先观察',
      images: [],
      onRetire: retirement => retirements.push(retirement),
    })
    await api.pushFollow(SID, { type: 'event', event: promptEvent(0, handle.requestId) as never })
    handle.abandon()
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
  })

  it('retires once when the queue and durable event report the same request id', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: PendingSubmissionRetirement[] = []
    const handle = session.beginSubmission({
      text: '同一请求',
      images: [],
      onRetire: retirement => retirements.push(retirement),
    })
    session.handleControlFrame({
      type: 'queue', sessionId: SID, items: [queuedItem(handle.requestId, [])],
    })
    await api.pushFollow(SID, {
      type: 'event', event: promptEvent(0, handle.requestId) as never,
    })
    await settleFrames()
    expect(retirements).toEqual([{ reason: 'observed', attachments: [] }])
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })

  it('uses requestAnimationFrame for the retirement delay when the runtime provides one', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      frames.push(fn)
      return frames.length
    })
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const handle = session.beginSubmission({ text: '帧', images: [] })
    await api.pushFollow(SID, { type: 'event', event: promptEvent(0, handle.requestId) as never })
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    expect(frames).toHaveLength(1)
    frames[0]?.(0)
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })
})

describe('disposal', () => {
  it('retires unsettled echoes as failed and preserves an already-observed settlement', async () => {
    const { api, session } = makeSession()
    api.onHistory = () => Promise.resolve(ok(historyValue([])))
    await session.open()
    const retirements: { text: string; retirement: PendingSubmissionRetirement }[] = []
    const observed = session.beginSubmission({
      text: '已观察',
      images: [],
      onRetire: retirement => retirements.push({ text: '已观察', retirement }),
    })
    session.beginSubmission({
      text: '未settle',
      images: [],
      onRetire: retirement => retirements.push({ text: '未settle', retirement }),
    })
    await api.pushFollow(SID, { type: 'event', event: promptEvent(0, observed.requestId) as never })
    await session.dispose()
    await settleFrames()
    expect(retirements).toEqual([
      { text: '未settle', retirement: { reason: 'failed' } },
      { text: '已观察', retirement: { reason: 'observed', attachments: [] } },
    ])
    expect(session.getSnapshot().pendingSubmissions).toEqual([])
  })
})
