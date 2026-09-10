import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeHeapWatermark,
  heapWatermarkExceeded,
  installHeapWatch,
  sampleHeapWatermark,
  type HeapWatermark,
} from '../src/heap-watch.ts'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function watermark(overrides: Partial<HeapWatermark> = {}): HeapWatermark {
  return {
    heapUsedBytes: GIB,
    heapLimitBytes: 4 * GIB,
    rssBytes: 2 * GIB,
    agents: 3,
    events: 4096,
    ...overrides,
  }
}

/** Sleep past a real timer, so the sampling cases need no fake-timer plumbing. */
function tick(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('heap watermark numbers', () => {
  it('renders every sampled number in one line', () => {
    expect(describeHeapWatermark(watermark())).toBe(
      'session-controller heap watermark: heap 1024MiB/4096MiB (25%), '
      + 'rss 2048MiB, retained agents 3, retained events 4096',
    )
  })

  it('treats the warn share as inclusive and a missing limit as unsurveyed', () => {
    expect(heapWatermarkExceeded(watermark({ heapUsedBytes: 3 * GIB }), 0.75)).toBe(true)
    expect(heapWatermarkExceeded(watermark({ heapUsedBytes: 3 * GIB - 1 }), 0.75)).toBe(false)
    expect(heapWatermarkExceeded(watermark({ heapUsedBytes: 9 * GIB, heapLimitBytes: 0 }), 0)).toBe(false)
  })

  it('samples this process and passes retained counters through untouched', () => {
    const sample = sampleHeapWatermark(() => ({ agents: 7, events: 1234 }))
    expect(sample.heapLimitBytes).toBeGreaterThan(0)
    expect(sample.heapUsedBytes).toBeGreaterThan(0)
    expect(sample.heapUsedBytes).toBeLessThanOrEqual(sample.heapLimitBytes)
    expect(sample.rssBytes).toBeGreaterThan(0)
    expect(sample.agents).toBe(7)
    expect(sample.events).toBe(1234)
  })
})

describe('heap watermark installation', () => {
  it('reports at info while the heap is below the warn share', async () => {
    const ctx = new Context()
    roots.push(ctx)
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    installHeapWatch(ctx, {
      intervalMs: 1000,
      warnRatio: 1,
      snapshotNearLimit: 0,
      retained: () => ({ agents: 0, events: 0 }),
    })

    expect(info).toHaveBeenCalledOnce()
    expect(info.mock.calls[0]?.[0]).toContain('session-controller heap watermark')
    expect(info.mock.calls[0]?.[0]).toContain('retained agents 0')
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns at the configured share and stops sampling once its fiber disposes', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    installHeapWatch(ctx, {
      intervalMs: 5,
      warnRatio: 0,
      snapshotNearLimit: 0,
      retained: () => ({ agents: 1, events: 2 }),
    })
    expect(warn).toHaveBeenCalledOnce()

    await tick(40)
    const sampled = warn.mock.calls.length
    expect(sampled).toBeGreaterThan(1)

    await ctx.fiber.dispose()
    await tick(40)
    expect(warn.mock.calls.length).toBe(sampled)
  })

  it('arms the near-limit snapshot hook only when the deployment asks for it', async () => {
    const ctx = new Context()
    roots.push(ctx)
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})

    installHeapWatch(ctx, {
      intervalMs: 1000,
      warnRatio: 1,
      snapshotNearLimit: 1,
      retained: () => ({ agents: 0, events: 0 }),
    })

    expect(info).toHaveBeenCalledOnce()
  })

  it('installs nothing at all when the interval is zero', async () => {
    const ctx = new Context()
    roots.push(ctx)
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    installHeapWatch(ctx, {
      intervalMs: 0,
      warnRatio: 0,
      snapshotNearLimit: 0,
      retained: () => ({ agents: 0, events: 0 }),
    })

    await tick(20)
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('fails loud on an unusable policy, even behind a disabled interval', () => {
    const ctx = new Context()
    roots.push(ctx)
    const counters = (): { agents: number; events: number } => ({ agents: 0, events: 0 })

    expect(() => {
      installHeapWatch(ctx, {
        intervalMs: -1,
        warnRatio: 0.5,
        snapshotNearLimit: 0,
        retained: counters,
      })
    }).toThrow(/heapWatchIntervalMs/)

    expect(() => {
      installHeapWatch(ctx, {
        intervalMs: 1000,
        warnRatio: 1.5,
        snapshotNearLimit: 0,
        retained: counters,
      })
    }).toThrow(/heapWatchWarnRatio/)

    expect(() => {
      installHeapWatch(ctx, {
        intervalMs: 1000,
        warnRatio: 0.5,
        snapshotNearLimit: 1.5,
        retained: counters,
      })
    }).toThrow(/heapWatchSnapshotNearLimit/)

    // Validation precedes the disabled short-circuit: a bad ratio must not hide
    // behind an interval a deployment switched off.
    expect(() => {
      installHeapWatch(ctx, {
        intervalMs: 0,
        warnRatio: 2,
        snapshotNearLimit: 0,
        retained: counters,
      })
    }).toThrow(/heapWatchWarnRatio/)
  })
})
