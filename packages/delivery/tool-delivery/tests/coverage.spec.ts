import { describe, expect, it } from 'vitest'
import {
  coverageReport,
  describeCoverageGap,
  designPoints,
  hasCoverageGap,
  parseChecklist,
  scenarioPoints,
} from '../src/coverage.ts'
import type { CoveragePoint } from '../src/coverage.ts'

/** A delta spec with one requirement carrying two scenarios. */
const SPEC = [
  '## ADDED Requirements',
  '### Requirement: 规模分级三层判定',
  '#### Scenario: 长需求直接升 l2',
  '- **WHEN** the request is long',
  '#### Scenario: 短需求命中强信号升 l2',
  '- **WHEN** a strong signal matches',
].join('\n')

const POINTS: readonly CoveragePoint[] = [
  { key: 'cap/a', source: 'scenario' },
  { key: 'cap/b', source: 'scenario' },
]

describe('coverage point extraction', () => {
  it('keys each scenario by its capability', () => {
    expect(scenarioPoints('delivery-discipline', SPEC).map(point => point.key)).toEqual([
      'delivery-discipline/长需求直接升 l2',
      'delivery-discipline/短需求命中强信号升 l2',
    ])
  })

  it('finds no scenarios in a spec without scenario headings', () => {
    expect(scenarioPoints('cap', '## ADDED Requirements\n')).toEqual([])
  })

  it('keys each design decision from its `### D<n>` heading', () => {
    expect(designPoints('### D1 规模三层判定\n\ntext\n').map(point => point.key))
      .toEqual(['design/D1'])
  })
})

describe('parseChecklist', () => {
  it('reads done state, content, and declared points', () => {
    const items = parseChecklist('- [x] build it (covers: cap/a)\n- [ ] ship it\n')
    expect(items[0]).toEqual({ content: 'build it', done: true, covers: ['cap/a'] })
    expect(items[1]).toEqual({ content: 'ship it', done: false, covers: [] })
  })

  it('accepts an uppercase done marker and several points', () => {
    const items = parseChecklist('- [X] both (covers: cap/a, cap/b)')
    expect(items[0]?.done).toBe(true)
    expect(items[0]?.covers).toEqual(['cap/a', 'cap/b'])
  })

  it('ignores lines that are not checkboxes', () => {
    expect(parseChecklist('## heading\nplain text\n')).toEqual([])
  })
})

describe('coverageReport', () => {
  it('reports points no item claims', () => {
    const report = coverageReport(POINTS, parseChecklist('- [x] x (covers: cap/a)'))
    expect(report.uncovered).toEqual(['cap/b'])
    expect(hasCoverageGap(report)).toBe(true)
  })

  it('reports items anchored to unknown points and items with no anchor', () => {
    const report = coverageReport(POINTS, parseChecklist('- [x] x (covers: cap/zzz)\n- [ ] y'))
    expect(report.orphanItems).toEqual(['x → cap/zzz'])
    expect(report.unanchoredItems).toEqual(['y'])
  })

  it('is complete when every point is claimed and every item is anchored', () => {
    const report = coverageReport(POINTS, parseChecklist('- [x] x (covers: cap/a, cap/b)'))
    expect(report.uncovered).toEqual([])
    expect(hasCoverageGap(report)).toBe(false)
  })

  it('describes every kind of gap', () => {
    const report = coverageReport(POINTS, parseChecklist('- [ ] x'))
    const text = describeCoverageGap(report)
    expect(text).toContain('uncovered points')
    expect(text).toContain('without a covers annotation')
  })
})
