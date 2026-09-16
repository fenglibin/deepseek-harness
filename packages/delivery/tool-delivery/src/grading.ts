/**
 * Programmatic size grading for delivery tasks: signal scanning over the
 * request text plus the tier decision itself. Kept free of cordis and tool
 * imports so the decision can be tested without a composition.
 * @module @deepseek-ai/dsh-tool-delivery/grading
 */

import type { DeliveryLevel } from '@deepseek-ai/dsh-delivery'

/** How many signals of each strength the request text matched. */
export interface SignalHits {
  /** Strong signal hits; one is enough to classify as `l2`. */
  readonly strong: number
  /** Medium signal hits; two classify as `l2`, one as `l1`. */
  readonly medium: number
  /** Weak signal hits; two classify as `l1`. */
  readonly weak: number
}

/** The grading inputs a deployment may override. */
export interface GradingPolicy {
  /** Objectives longer than this classify as `l2` without scanning signals. */
  readonly specChars: number
  /** Patterns whose first hit classifies as `l2`. */
  readonly strongSignals: readonly string[]
  /** Patterns whose second hit classifies as `l2` and whose first hit classifies as `l1`. */
  readonly mediumSignals: readonly string[]
  /** Patterns whose second hit classifies as `l1`. */
  readonly weakSignals: readonly string[]
}

/** Structural-contract, security, compatibility, and migration work. */
export const DEFAULT_STRONG_SIGNALS: readonly string[] = [
  'capability seam',
  'session event',
  'session/',
  'schema',
  'projection',
  '公共 api',
  '公共api',
  '公共符号',
  '协议',
  'protocol',
  'rpc',
  'ipc',
  'sdk',
  '数据格式',
  'wire',
  'session format',
  'session_format_version',
  '数据库',
  'database',
  '磁盘格式',
  '跨版本',
  '安全',
  'security',
  '鉴权',
  'auth',
  '权限',
  'permission',
  '沙箱',
  'sandbox',
  '密钥',
  'secret',
  '注入',
  'injection',
  '兼容',
  'compat',
  'breaking',
  '废弃',
  'deprecat',
  '迁移',
  'migrat',
  '删除公共',
]

/** Cross-plane, multi-package, new-capability, and design-tradeoff work. */
export const DEFAULT_MEDIUM_SIGNALS: readonly string[] = [
  '跨 host',
  '跨端',
  '两端',
  'client',
  '客户端',
  'packages/',
  '多个包',
  '跨包',
  '新增',
  '新功能',
  '新能力',
  'feature',
  '设计决策',
  '权衡',
  '选型',
  'tradeoff',
  // Restructuring words are used loosely in ordinary requests, so they raise
  // a request to the design-document tier rather than to the OpenSpec tier.
  '重构',
  'refactor',
  '重写',
  'rewrite',
  '升级',
  'upgrad',
  '替换',
  'replac',
]

/** Decomposability, performance budget, and user-visible presentation work. */
export const DEFAULT_WEAK_SIGNALS: readonly string[] = [
  '子任务',
  'subtask',
  '拆分',
  '性能',
  'performance',
  '优化',
  'optimiz',
  '预算',
  'budget',
  '界面',
  '页面',
  '展示',
  '呈现',
  '交互',
]

/** Numbered requirement items; three or more means decomposable work. */
const NUMBERED_ITEM = /(?:^|\n)\s*\d{1,2}\s*[、.．)）]\s*\S/g

/** Minimum numbered items that count as one medium signal. */
const DECOMPOSABLE_ITEMS = 3

/** Count how many patterns occur in the normalized text. */
function countHits(text: string, patterns: readonly string[]): number {
  let hits = 0
  for (const pattern of patterns) {
    const needle = pattern.trim().toLowerCase()
    if (needle.length > 0 && text.includes(needle)) hits += 1
  }
  return hits
}

/** Count numbered items such as `1、` or `2.` at the start of a line. */
function numberedItemCount(objective: string): number {
  const matches = objective.match(NUMBERED_ITEM)
  return matches === null ? 0 : matches.length
}

/**
 * Count the signals the objective matches at each strength.
 *
 * A numbered list is one medium signal, not a strong one: listing several
 * points expresses decomposability, which `l1` already covers with a design
 * document, while `l2` means a structural-contract change that owes the full
 * OpenSpec change set. Counting the list as strong made every request written
 * as three numbered points an `l2` regardless of its size.
 * @param objective - normalized request text.
 * @param policy - grading patterns and the spec threshold.
 * @returns hits per strength; decomposable numbered lists count as medium.
 */
export function scanSignals(objective: string, policy: GradingPolicy): SignalHits {
  const text = objective.toLowerCase()
  const decomposable = numberedItemCount(objective) >= DECOMPOSABLE_ITEMS ? 1 : 0
  return {
    strong: countHits(text, policy.strongSignals),
    medium: countHits(text, policy.mediumSignals) + decomposable,
    weak: countHits(text, policy.weakSignals),
  }
}

/**
 * The concrete evidence behind one graded level.
 *
 * A level alone is not actionable to a reader who disagrees with it: the
 * question is always which threshold or which pattern produced it. Each field
 * therefore names the fact that decided the tier.
 */
export interface GradingRationale {
  /** The level this grading produced. */
  readonly level: DeliveryLevel
  /** Which rule decided it: the character floor, the signal scan, or nothing. */
  readonly decidedBy: 'character-floor' | 'signal-scan' | 'nothing'
  /** Objective length, and the floor it was compared against. */
  readonly chars: number
  readonly charFloor: number
  /** Patterns the objective matched, per strength. */
  readonly matched: {
    readonly strong: readonly string[]
    readonly medium: readonly string[]
    readonly weak: readonly string[]
  }
  /** Whether a numbered list contributed one of the medium hits. */
  readonly numberedList: boolean
}

/** The patterns of one list that occur in the normalized text. */
function matchedPatterns(text: string, patterns: readonly string[]): readonly string[] {
  return patterns.filter((pattern) => {
    const needle = pattern.trim().toLowerCase()
    return needle.length > 0 && text.includes(needle)
  })
}

/**
 * Explain how one objective was graded, naming the deciding evidence.
 * @param objective - direct human request text.
 * @param policy - grading thresholds and patterns.
 * @returns the level and the facts that produced it.
 */
export function explainGrading(objective: string, policy: GradingPolicy): GradingRationale {
  const text = objective.toLowerCase()
  const strong = matchedPatterns(text, policy.strongSignals)
  const medium = matchedPatterns(text, policy.mediumSignals)
  const weak = matchedPatterns(text, policy.weakSignals)
  const numbered = numberedItemCount(objective) >= DECOMPOSABLE_ITEMS
  // The floor is checked first and returns before any scanning, so an
  // over-floor request reports length as the decision even when it also
  // matches patterns.
  const decidedBy = objective.length > policy.specChars
    ? 'character-floor'
    : strong.length > 0 || medium.length > 0 || weak.length > 0 || numbered
      ? 'signal-scan'
      : 'nothing'
  return {
    level: gradeObjective(objective, policy),
    decidedBy,
    chars: objective.length,
    charFloor: policy.specChars,
    matched: { strong, medium, weak },
    numberedList: numbered,
  }
}

/**
 * Classify a request into a delivery level using the three-tier decision:
 * character floor, then signal scan, then nothing (free execution).
 * @param objective - direct human request text.
 * @param policy - grading thresholds and patterns.
 * @returns `l2` above the character floor or on a strong signal or two medium
 * signals, `l1` on one medium or two weak signals, and `l0` when nothing is hit.
 */
export function gradeObjective(objective: string, policy: GradingPolicy): DeliveryLevel {
  if (objective.length > policy.specChars) return 'l2'
  const hits = scanSignals(objective, policy)
  if (hits.strong > 0) return 'l2'
  if (hits.medium >= 2) return 'l2'
  if (hits.medium === 1 || hits.weak >= 2) return 'l1'
  return 'l0'
}
