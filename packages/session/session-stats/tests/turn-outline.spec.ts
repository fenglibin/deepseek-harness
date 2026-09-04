/**
 * The `turnOutline` projection unit: mounting the stats plugin beside the
 * projection registry serves the whole-log list of turns that opened with a
 * direct user prompt, so the client drawer can list every user message
 * regardless of how much history it has paged in.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import type { TurnOutlineProjection } from '@deepseek-ai/dsh-session-stats/types'

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStatsPlugin)
  return { ctx, session: ctx.sessions.create(SessionId('outlined')) }
}

const projected = (ctx: Context, session: Session): TurnOutlineProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.turnOutline
  if (value === undefined) throw new Error('turnOutline projection is not registered')
  return value
}

/** Append one complete single-step turn opening with `prompt`. */
function appendTurn(session: Session, turn: number, prompt: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('turnOutline session projection', () => {
  it('serves an empty outline for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual({ turns: [] })
  })

  it('lists each direct user prompt in turn order', async () => {
    const { ctx, session } = await harness()
    appendTurn(session, 1, 'first question')
    appendTurn(session, 2, 'second question')
    expect(projected(ctx, session)).toEqual({
      turns: [
        { turn: 1, prompt: 'first question' },
        { turn: 2, prompt: 'second question' },
      ],
    })
  })

  it('omits turns without a direct user prompt', async () => {
    const { ctx, session } = await harness()
    // A turn whose only user/message is injected context is not a user prompt.
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    appendTurn(session, 2, 'real question')
    expect(projected(ctx, session)).toEqual({
      turns: [{ turn: 2, prompt: 'real question' }],
    })
  })

  it('captures only the first direct prompt of a turn', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'opening' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // A steering message later in the same turn must not replace the opening prompt.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'steering' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(projected(ctx, session)).toEqual({
      turns: [{ turn: 1, prompt: 'opening' }],
    })
  })

  it('bounds a long prompt to the preview limit', async () => {
    const { ctx, session } = await harness()
    appendTurn(session, 1, 'x'.repeat(500))
    const [entry] = projected(ctx, session).turns
    expect(entry?.prompt.length).toBeLessThanOrEqual(160)
    expect(entry?.prompt).toBe('x'.repeat(160))
  })
})
