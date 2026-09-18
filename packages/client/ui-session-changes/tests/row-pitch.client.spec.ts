/**
 * The viewer's row pitch must equal the line-height its own content font
 * declares.
 *
 * A diff row's height is driven by the text it holds, so the pitch is a FLOOR
 * for a text row and the WHOLE height of a filler — the empty half of a
 * one-sided change. If the pitch is smaller than the font's line-height, every
 * filler shortens one lane and the two columns drift apart by the difference,
 * which is exactly the misalignment a reader reports as "the unchanged lines do
 * not line up". The two values live in different files, so this gate reads them
 * from source rather than trusting them to stay in step.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

/** The declared value of one custom property, from the file that owns it. */
function declared(css: string, property: string): string | undefined {
  return new RegExp(`${property}:\\s*([^;]+);`).exec(css)?.[1]?.trim()
}

describe('diff row pitch', () => {
  const viewer = readFileSync(resolve(root, 'src/client/RevisionDiffOverlay.module.css'), 'utf8')
  const theme = readFileSync(
    resolve(root, '../ui-theme/src/styles/gradient-shadow-text.css'),
    'utf8',
  )

  it('equals the content code font line-height the theme declares', () => {
    const font = declared(theme, '--dsh-content-font-code')
    expect(font, 'the theme must declare the content code font').toBeDefined()
    // `size/line-height family`: the line-height is the text between the slash
    // and the family token, which is a `var(...)` reference (possibly wrapped in
    // `calc()` with spaces of its own).
    // The family is the final `var(...)` token, so the line-height is everything
    // before the LAST ` var(` — an earlier one belongs to a nested calc().
    const afterSlash = font?.split('/')[1] ?? ''
    const lineHeight = afterSlash.slice(0, afterSlash.lastIndexOf(' var(')).trim()
    expect(lineHeight).toBe('calc(24px + var(--dsh-content-font-delta, 0px))')
    expect(declared(viewer, '--dsl-rv-line-height')).toBe(lineHeight)
  })

  it('gives a cell the row height rather than only a floor', () => {
    // `min-height` alone would let a filler collapse to the pitch while its
    // opposite number keeps the font's taller box.
    const cell = /\.cell\s*\{([^}]*)\}/.exec(viewer)?.[1] ?? ''
    expect(cell).toMatch(/height:\s*var\(--dsl-rv-line-height\)/)
    expect(cell).toMatch(/line-height:\s*var\(--dsl-rv-line-height\)/)
  })
})
