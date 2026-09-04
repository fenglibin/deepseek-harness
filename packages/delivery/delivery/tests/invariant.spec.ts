/**
 * The delivery-stream invariant companion: mounts the independent incremental
 * fold beside the invariant registry and rejects an incoherent durable stream
 * before it enters the log, matching the goal invariant suite.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DeliveryTaskId } from '@deepseek-ai/dsh-delivery'
import * as DeliveryInvariant from '@deepseek-ai/dsh-delivery/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { DeliveryRecordChangeMeta, DeliverySnapshotChangeMeta } from '@deepseek-ai/dsh-delivery'

const create: DeliverySnapshotChangeMeta = {
  kind: 'delivery/change',
  version: 1,
  operation: 'create',
  task: {
    id: DeliveryTaskId('task-invariant'),
    revision: 1,
    objective: 'check the stream',
    phase: 'created',
    level: 'l0',
    changeCount: 0,
    designCount: 0,
    specCount: 0,
  },
  createdAt: 1,
  updatedAt: 1,
}

function recordChange(revision: number, text: string, updatedAt: number): DeliveryRecordChangeMeta {
  return {
    kind: 'delivery/change',
    version: 1,
    operation: 'record-change',
    ref: { id: create.task.id, revision },
    text,
    changeCount: revision - 1,
    updatedAt,
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(DeliveryInvariant)
  return ctx
}

describe('delivery stream invariants', () => {
  it('accepts canonical creates and sequential record-changes', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('delivery-invariant-valid'))
    expect(() => session.append('delivery/change', create)).not.toThrow()
    expect(() => session.append('delivery/change', recordChange(2, 'the fix', 2))).not.toThrow()
  })

  it('rejects a malformed delivery change before committing it and keeps the fold reusable', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('delivery-invariant-invalid'))
    expect(() => session.append('delivery/change', { ...create, extra: true } as never)).toThrow(
      expect.objectContaining<Partial<InvariantError>>({
        code: 'INVARIANT',
        packageName: '@deepseek-ai/dsh-delivery',
      }),
    )
    expect(session.seq).toBe(0)
    expect(() => session.append('delivery/change', create)).not.toThrow()
  })

  it('reconstructs an existing durable task before checking later changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('delivery-invariant-late-load'))
    session.append('delivery/change', create)

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(DeliveryInvariant)
    expect(() => session.append('delivery/change', recordChange(2, 'after load', 2))).not.toThrow()
  })

  it('seeds sessions created after installation', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('delivery-invariant-created'))
    expect(() => session.append('delivery/change', create)).not.toThrow()
  })
})
