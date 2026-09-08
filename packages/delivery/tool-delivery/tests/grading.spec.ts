import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEDIUM_SIGNALS,
  DEFAULT_STRONG_SIGNALS,
  DEFAULT_WEAK_SIGNALS,
  gradeObjective,
  scanSignals,
} from '../src/grading.ts'
import type { GradingPolicy } from '../src/grading.ts'

/** Policy built from the shipped defaults with an overridable char floor. */
function policy(overrides: Partial<GradingPolicy> = {}): GradingPolicy {
  return {
    specChars: 200,
    strongSignals: DEFAULT_STRONG_SIGNALS,
    mediumSignals: DEFAULT_MEDIUM_SIGNALS,
    weakSignals: DEFAULT_WEAK_SIGNALS,
    ...overrides,
  }
}

/** Text of an exact length that matches no signal. */
function filler(length: number): string {
  return '啊'.repeat(length)
}

describe('gradeObjective', () => {
  it('classifies a request above the character floor as l2 without scanning', () => {
    expect(gradeObjective(filler(201), policy())).toBe('l2')
  })

  it('leaves a request at the character floor to the signal scan', () => {
    expect(gradeObjective(filler(200), policy())).toBe('l0')
  })

  it('classifies a strong signal hit as l2', () => {
    expect(gradeObjective('重构这个模块的内部实现', policy())).toBe('l2')
  })

  it('classifies cross-process and persistence-format words as strong signals', () => {
    expect(gradeObjective('改动 RPC 协议', policy())).toBe('l2')
    expect(gradeObjective('升级 SESSION_FORMAT_VERSION 磁盘格式', policy())).toBe('l2')
  })

  it('matches strong signals case-insensitively', () => {
    expect(gradeObjective('Refactor the module internals', policy())).toBe('l2')
  })

  it('classifies one medium signal as l1 and two as l2', () => {
    expect(gradeObjective('新增一个小能力', policy())).toBe('l1')
    expect(gradeObjective('新增 client 端的能力', policy())).toBe('l2')
  })

  it('classifies two weak signals as l1', () => {
    expect(gradeObjective('优化页面性能', policy())).toBe('l1')
  })

  it('leaves a small unremarkable request at l0', () => {
    expect(gradeObjective('修复这个拼写错误', policy())).toBe('l0')
  })

  it('treats three numbered requirement items as a strong signal', () => {
    const objective = '1、改 A\n2、改 B\n3、改 C\n4、改 D'
    expect(gradeObjective(objective, policy())).toBe('l2')
  })

  it('ignores a numbered list shorter than three items', () => {
    const objective = '1、改 A\n2、改 B'
    expect(scanSignals(objective, policy()).strong).toBe(0)
  })

  it('returns l0 for an empty objective', () => {
    expect(gradeObjective('', policy())).toBe('l0')
  })

  it('returns l0 when every signal list is empty', () => {
    const bare = policy({ strongSignals: [], mediumSignals: [], weakSignals: [] })
    expect(gradeObjective('重构这个模块', bare)).toBe('l0')
  })

  it('honors a raised character floor', () => {
    expect(gradeObjective(filler(500), policy({ specChars: 800 }))).toBe('l0')
  })
})

describe('scanSignals', () => {
  it('counts hits per strength', () => {
    const hits = scanSignals('新增 client 端的 schema 迁移', policy())
    expect(hits.strong).toBeGreaterThan(0)
    expect(hits.medium).toBeGreaterThanOrEqual(2)
  })

  it('ignores blank patterns', () => {
    const hits = scanSignals('重构', policy({ strongSignals: ['  ', '重构'] }))
    expect(hits.strong).toBe(1)
  })
})
