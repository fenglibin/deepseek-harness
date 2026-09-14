/**
 * The `turnTiming` projection unit: a whole-log fold of each completed turn's
 * wall time, first-token latency, and decode throughput, keyed by turn number.
 * The unit exists so a turn whose `turn/start` boundary is paged out of a
 * client's loaded window still discloses its timing, exactly as the
 * `turnUsage` unit does for billing. Wall-time math runs against the exported
 * fold directly, where event times are controlled.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import { deriveTurnTiming, turnTimingProjectionDefinition } from '@deepseek-ai/dsh-session-stats/src/turn-timing.ts'
import type { TurnTimingProjection } from '@deepseek-ai/dsh-session-stats/types'

const message = createMessage({
  role: 'assistant',
  content: [{ type: 'text', text: 'answer' }],
  source: { kind: 'model', provider: 'mock', model: 'mock' },
})

/** Build one synthetic committed event with a controlled timestamp. */
function at(time: number, type: string, data: unknown): SessionEvent {
  return { type, seq: time, time, data } as unknown as SessionEvent
}

/** Fold a synthetic event list through the definition and view the result. */
function fold(events: readonly SessionEvent[]): TurnTimingProjection {
  const state = events.reduce<Parameters<typeof turnTimingProjectionDefinition.apply>[0]>(
    (folded, event) => turnTimingProjectionDefinition.apply(folded, event),
    turnTimingProjectionDefinition.init(),
  )
  return turnTimingProjectionDefinition.wire.view(state)
}

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStatsPlugin)
  return { ctx, session: ctx.sessions.create(SessionId('timed')) }
}

const projected = (ctx: Context, session: Session): TurnTimingProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.turnTiming
  if (value === undefined) throw new Error('turnTiming projection is not registered')
  return value
}

describe('turnTiming fold (controlled timestamps)', () => {
  it('serves no turns for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual({ turns: {} })
  })

  it('folds wall time, first-token latency, and throughput from one fully recorded step', () => {
    expect(fold([
      at(1_000, 'turn/start', { turn: 1 }),
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(1_800, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } }),
      at(4_800, 'assistant/message', { turn: 1, step: 1, message, usage: { inputTokens: 10, outputTokens: 60 } }),
      at(4_900, 'step/end', { turn: 1, step: 1 }),
      at(9_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])).toEqual({
      // 60 tokens over the 3s decode span; one step, so peak equals average.
      turns: { 1: { runMs: 8_000, ttftMs: 800, tokensPerSecond: 20, peakTokensPerSecond: 20 } },
    })
  })

  it('takes the peak from the fastest step while the average spans them all', () => {
    expect(fold([
      at(1_000, 'turn/start', { turn: 1 }),
      // 200 tokens over 2s → 100 tok/s, then 100 tokens over 8s → 12.5 tok/s.
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(1_000, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } }),
      at(3_000, 'assistant/message', { turn: 1, step: 1, message, usage: { inputTokens: 1, outputTokens: 200 } }),
      at(3_100, 'step/end', { turn: 1, step: 1 }),
      at(4_000, 'step/start', { turn: 1, step: 2 }),
      at(4_000, 'assistant/chunk', { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'b' } }),
      at(12_000, 'assistant/message', { turn: 1, step: 2, message, usage: { inputTokens: 1, outputTokens: 100 } }),
      at(12_100, 'step/end', { turn: 1, step: 2 }),
      at(20_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])).toEqual({
      turns: { 1: { runMs: 19_000, ttftMs: 0, tokensPerSecond: 30, peakTokensPerSecond: 100 } },
    })
  })

  it('keeps turns independent so every completed turn discloses its own timing', () => {
    expect(fold([
      at(1_000, 'turn/start', { turn: 1 }),
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(1_200, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } }),
      at(2_200, 'assistant/message', { turn: 1, step: 1, message, usage: { inputTokens: 1, outputTokens: 30 } }),
      at(2_300, 'step/end', { turn: 1, step: 1 }),
      at(5_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(6_000, 'turn/start', { turn: 2 }),
      at(6_000, 'step/start', { turn: 2, step: 1 }),
      at(6_500, 'assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } }),
      at(8_500, 'assistant/message', { turn: 2, step: 1, message, usage: { inputTokens: 1, outputTokens: 40 } }),
      at(8_600, 'step/end', { turn: 2, step: 1 }),
      at(9_000, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])).toEqual({
      turns: {
        1: { runMs: 4_000, ttftMs: 200, tokensPerSecond: 30, peakTokensPerSecond: 30 },
        2: { runMs: 3_000, ttftMs: 500, tokensPerSecond: 20, peakTokensPerSecond: 20 },
      },
    })
  })

  it('discloses wall time and TTFT without throughput when no step reports usage', () => {
    expect(fold([
      at(1_000, 'turn/start', { turn: 1 }),
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(1_900, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } }),
      at(3_000, 'assistant/message', { turn: 1, step: 1, message }),
      at(3_100, 'step/end', { turn: 1, step: 1 }),
      at(5_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])).toEqual({ turns: { 1: { runMs: 4_000, ttftMs: 900 } } })
  })

  it('omits throughput when the decode span is zero instead of reporting an unbounded rate', () => {
    expect(fold([
      at(1_000, 'turn/start', { turn: 1 }),
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(1_500, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } }),
      at(1_500, 'assistant/message', { turn: 1, step: 1, message, usage: { inputTokens: 1, outputTokens: 12 } }),
      at(1_600, 'step/end', { turn: 1, step: 1 }),
      at(4_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])).toEqual({ turns: { 1: { runMs: 3_000, ttftMs: 500 } } })
  })

  it('keeps the first-token boundary across an in-step retry (window resetForRetry parity)', () => {
    expect(fold([
      at(1_000, 'turn/start', { turn: 1 }),
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(1_200, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'x' } }),
      at(2_000, 'llm/retry', { turn: 1, step: 1 }),
      at(3_000, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'y' } }),
      at(5_000, 'assistant/message', { turn: 1, step: 1, message, usage: { inputTokens: 1, outputTokens: 38 } }),
      at(5_100, 'step/end', { turn: 1, step: 1 }),
      at(6_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])).toEqual({
      turns: { 1: { runMs: 5_000, ttftMs: 200, tokensPerSecond: 10, peakTokensPerSecond: 10 } },
    })
  })

  it('discloses nothing for a turn whose boundaries never both land', () => {
    expect(fold([
      at(1_000, 'turn/start', { turn: 1 }),
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(1_800, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } }),
    ])).toEqual({ turns: {} })
  })

  it('leaves events outside any turn untouched', () => {
    expect(fold([
      at(500, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'stray' } }),
      at(600, 'step/end', { turn: 1, step: 1 }),
    ])).toEqual({ turns: {} })
  })

  it('keeps the checkpoint state proportional to steps, not stream events', () => {
    // 一个回合、一个 step、5000 个流式 chunk：状态必须只保留 step 边界，而不是这 5000 个事件。
    const events: SessionEvent[] = [at(1_000, 'turn/start', { turn: 1 })]
    events.push(at(1_000, 'step/start', { turn: 1, step: 1 }))
    for (let index = 0; index < 5000; index++) {
      events.push(at(1_001 + index, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }))
    }
    events.push(at(6_001, 'assistant/message', { turn: 1, step: 1, message, usage: { inputTokens: 1, outputTokens: 5000 } }))
    events.push(at(6_002, 'step/end', { turn: 1, step: 1 }))
    events.push(at(7_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const state = events.reduce<Parameters<typeof turnTimingProjectionDefinition.apply>[0]>(
      (folded, event) => turnTimingProjectionDefinition.apply(folded, event),
      turnTimingProjectionDefinition.init(),
    )
    expect(JSON.stringify(state).length).toBeLessThan(1_000)
  })

  it('discloses the same entries the whole-log reference fold derives across turns', () => {
    const events: SessionEvent[] = [
      at(1_000, 'turn/start', { turn: 1 }),
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(1_800, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } }),
      at(4_800, 'assistant/message', { turn: 1, step: 1, message, usage: { inputTokens: 10, outputTokens: 60 } }),
      at(4_900, 'step/end', { turn: 1, step: 1 }),
      at(9_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(10_000, 'turn/start', { turn: 2 }),
      at(10_000, 'step/start', { turn: 2, step: 1 }),
      at(10_200, 'assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } }),
      at(12_000, 'assistant/message', { turn: 2, step: 1, message, usage: { inputTokens: 1, outputTokens: 40 } }),
      at(12_100, 'step/end', { turn: 2, step: 1 }),
      at(14_000, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    const projected = fold(events)
    expect(projected.turns['1']).toEqual(deriveTurnTiming(events.slice(0, 6)))
    expect(projected.turns['2']).toEqual(deriveTurnTiming(events.slice(6)))
  })
})

describe('turnTiming projection unit (registry drive)', () => {
  it('exposes every completed turn regardless of how the log is loaded', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message,
      usage: { inputTokens: 10, outputTokens: 60 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', {
      turn: 2,
      step: 1,
      message,
      usage: { inputTokens: 10, outputTokens: 20 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const value = projected(ctx, session)
    expect(Object.keys(value.turns).sort()).toEqual(['1', '2'])
    expect(value.turns['1']?.runMs).toBeGreaterThanOrEqual(0)
    expect(value.turns['2']?.runMs).toBeGreaterThanOrEqual(0)
  })

  it('publishes a turn on the change feed when it closes', async () => {
    const { ctx, session } = await harness()
    const changes: { value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      if (key === 'turnTiming') changes.push({ value, seq })
    })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const closed = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(changes.at(-1)?.seq).toBe(closed.seq)
    const last = changes.at(-1)?.value as TurnTimingProjection | undefined
    expect(last?.turns['1']?.runMs).toBeGreaterThanOrEqual(0)
  })

  it('has no turnTiming key without the plugin and drops it when the plugin unloads (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('unloaded'))
    expect('turnTiming' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(SessionStatsPlugin)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect('turnTiming' in ctx.sessionProjections.snapshot(session).values).toBe(true)
    await fiber.dispose()
    expect('turnTiming' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })
})

describe('deriveTurnTiming', () => {
  it('returns undefined when the turn boundaries are missing', () => {
    expect(deriveTurnTiming([])).toBeUndefined()
    expect(deriveTurnTiming([at(1_000, 'turn/start', { turn: 1 })])).toBeUndefined()
    expect(deriveTurnTiming([at(2_000, 'turn/end', { turn: 1, reason: { kind: 'completed' } })])).toBeUndefined()
  })
})
