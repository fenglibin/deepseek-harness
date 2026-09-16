/**
 * Drift guard for the phase table.
 *
 * The browser half keeps its own copy of `LEVEL_PHASES` because
 * `@deepseek-ai/dsh-delivery/client` is a pure type outlet with no runtime
 * exports, so the host table cannot be imported there. This spec — which runs
 * in the host face and may import the host package — asserts the two tables
 * are equal, so a change to the enforced order cannot leave the rendered order
 * behind.
 */

import { describe, expect, it } from 'vitest'
import { LEVEL_PHASES as HOST_LEVEL_PHASES } from '@deepseek-ai/dsh-delivery'
import { LEVEL_PHASES } from '../src/client/delivery-phases.ts'

describe('delivery phase table', () => {
  it('matches the host table the fold enforces', () => {
    expect(LEVEL_PHASES).toEqual(HOST_LEVEL_PHASES)
  })

  it('keeps every tier starting at created and ending at accepted', () => {
    for (const [level, phases] of Object.entries(LEVEL_PHASES)) {
      expect(phases[0], `${level} starts at created`).toBe('created')
      expect(phases[phases.length - 1], `${level} ends at accepted`).toBe('accepted')
    }
  })

  it('adds exactly one required phase per tier', () => {
    expect(LEVEL_PHASES.l1).toContain('designed')
    expect(LEVEL_PHASES.l0).not.toContain('designed')
    expect(LEVEL_PHASES.l2).toContain('specified')
    expect(LEVEL_PHASES.l1).not.toContain('specified')
  })
})
