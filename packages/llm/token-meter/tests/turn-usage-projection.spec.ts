import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { TurnUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

const projected = (ctx: Context, session: Session): TurnUsageProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.turnUsage
  if (value === undefined) throw new Error('turnUsage projection is not registered')
  return value
}

/** Append one complete single-step billed turn. */
function appendBilledTurn(session: Session, turn: number, usage: TokenUsage): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const source = session.append('assistant/chunk', {
    turn,
    step: 1,
    chunk: { type: 'usage', usage },
  }).seq
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append', sourceEventSeqs: [source] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('turnUsage session projection', () => {
  it('serves an empty map for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual({ turns: {} })
  })

  it('discloses one completed billed turn keyed by turn number', async () => {
    const { ctx, session } = await harness()
    appendBilledTurn(session, 1, {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 170,
      cacheReadTokens: 50,
    })
    expect(projected(ctx, session).turns['1']).toMatchObject({
      uncachedInputTokens: 100,
      outputTokens: 20,
      totalTokens: 170,
      cacheReadTokens: 50,
    })
  })

  it('accumulates usage across turns and omits an unbilled turn', async () => {
    const { ctx, session } = await harness()
    appendBilledTurn(session, 1, { inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    // A turn with no billed attempt stays out of the map.
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    appendBilledTurn(session, 3, { inputTokens: 30, outputTokens: 4, totalTokens: 34 })

    expect(Object.keys(projected(ctx, session).turns).sort()).toEqual(['1', '3'])
  })

  it('folds a turn whole even when its events arrive after unrelated events', async () => {
    const { ctx, session } = await harness()
    // Unrelated inter-turn events must not leak into a turn's buffer.
    appendBilledTurn(session, 1, { inputTokens: 5, outputTokens: 1, totalTokens: 6 })
    session.append('model/selection', { provider: 'mock', model: 'mock' })
    appendBilledTurn(session, 2, { inputTokens: 7, outputTokens: 2, totalTokens: 9 })

    const turns = projected(ctx, session).turns
    expect(turns['1']).toMatchObject({ totalTokens: 6 })
    expect(turns['2']).toMatchObject({ totalTokens: 9 })
  })

  it('restores from a JSON checkpoint after the meter unmounts', async () => {
    const { ctx, session } = await harness()
    appendBilledTurn(session, 1, { inputTokens: 8, outputTokens: 2, totalTokens: 10 })
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>

    expect(checkpoint.turnUsage?.ver).toBe(1)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).turnUsage).toMatchObject({
      turns: { '1': { uncachedInputTokens: 8, outputTokens: 2, totalTokens: 10 } },
    })
  })
})
