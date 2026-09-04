/**
 * The one-line contract of the ToolRow summary line as CSS text. jsdom has no
 * layout, so the rendering specs (chat-tool-row.spec.tsx) can pin which spans
 * exist but not whether a narrow row still fits on one line; these read the
 * declarations the layout depends on.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/tool/components/ToolRow.module.css', import.meta.url)), 'utf8')
/** Declarations only: the sheet's prose names the properties it explains. */
const declarationText = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

function declarations(selector: string): string[] {
  // Anchored at a rule boundary: an unanchored match would silently read a
  // compound rule that merely contains the selector (`.root:hover .summarySuffix`)
  // if one ever lands above the base rule.
  const rule = new RegExp(`(?:^|\\})\\s*\\${selector}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`ToolRow.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

/**
 * The bash row's output-height stages, as CSS text. jsdom has no layout, so
 * the rendering spec can pin which stage the row is in but not how many lines
 * that stage shows.
 */
const bashCss = readFileSync(fileURLToPath(new URL('../src/client/tool/toolviews/bash-sample.module.css', import.meta.url)), 'utf8')
const bashDeclarationText = bashCss.replace(/\/\*[\s\S]*?\*\//g, ' ')

function bashDeclarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|\\})\\s*\\${selector}\\s*\\{([^{}]*)\\}`).exec(bashDeclarationText)
  if (rule === null) throw new Error(`bash-sample.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

/**
 * One output stage; the selector's brackets are escaped, not a character class.
 * @param stage - stage name the `data-stage` attribute carries.
 * @param required - false when the assertion is that the stage has NO rule,
 *   which is how a removed stage stays pinned.
 * @returns the stage's declarations; empty when it has no rule.
 */
function stageDeclarations(stage: string, required = true): string[] {
  const rule = new RegExp(
    `\\.terminalWrap\\[data-stage='${stage}'\\] \\.terminal\\s*\\{([^{}]*)\\}`,
  ).exec(bashDeclarationText)
  if (rule === null) {
    if (required) throw new Error(`bash-sample.module.css has no '${stage}' stage rule`)
    return []
  }
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('bash row output-height stages', () => {
  it('caps the open row at ten lines and declares no closed stage', () => {
    // A closed row renders no terminal at all, so `peek` is gone: every
    // settled row collapses to the one-line summary the other tool rows use.
    expect(stageDeclarations('peek', false)).toEqual([])
    expect(stageDeclarations('full')).toEqual([
      '--dsl-terminal-output-max-height: calc(var(--dsl-terminal-line-height) * 10)',
    ])
  })

  it('derives the cap from the line height the row reads, never a copied px value', () => {
    // A cap written in px would drift from the terminal's own line height the
    // moment that binding changed, leaving the row showing half a line. The row
    // no longer rebinds the measure: the primitive's default rides the content
    // font-size axis, so the Settings size reaches command output too.
    expect(bashDeclarations('.terminal')).not.toEqual(expect.arrayContaining([
      expect.stringContaining('--dsl-terminal-font'),
      '--dsl-terminal-line-height: 18px',
    ]))
    expect(stageDeclarations('full').join(';')).toContain('var(--dsl-terminal-line-height)')
  })

  it('leaves the unbounded stage without a cap', () => {
    // The primitive reads `none` by default, so the overflow never engages.
    expect(bashDeclarations('.terminal')).not.toEqual(expect.arrayContaining([
      '--dsl-terminal-output-max-height: none',
    ]))
    expect(stageDeclarations('full').join(';')).not.toContain('none')
  })
})

describe('ToolRow.module.css summary line', () => {
  it('keeps the summary suffix on one line and unshrunk', () => {
    // `flex: none` stops the box shrinking, not the text wrapping: without
    // `nowrap`, a row too narrow for title + separator + suffix wraps the `+n`
    // onto a second line — the exact case the slot exists to survive.
    expect(declarations('.summarySuffix')).toEqual(expect.arrayContaining([
      'flex: none',
      'white-space: nowrap',
    ]))
  })

  it('leaves the truncation to the summary text alone', () => {
    // The suffix must never ellipsize: a clipped count reads as a smaller
    // number rather than as missing information.
    expect(declarations('.summary')).toEqual(expect.arrayContaining([
      'overflow: hidden',
      'text-overflow: ellipsis',
      'white-space: nowrap',
    ]))
    expect(declarations('.summarySuffix')).not.toEqual(expect.arrayContaining(['text-overflow: ellipsis']))
  })

  it('sizes the summary texts at the body size, not the secondary tier', () => {
    // The Settings font-size preference must reach tool-call rows at the size
    // it names: summary, suffix, and file link read the body size itself, so a
    // row does not stay one step below the narration it sits among.
    for (const selector of ['.summary', '.summarySuffix', '.fileLink']) {
      expect(declarations(selector)).toEqual(expect.arrayContaining([
        'font-size: var(--dsh-content-font-size, 14px)',
        'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
      ]))
    }
  })

  it('rebinds the shared disclosure title so the whole row reads one size', () => {
    // The shared header defaults to the secondary tier for the flow's meta
    // rows; a tool row's title sits beside body-size text, so it lifts with it.
    expect(declarations('.root')).toEqual(expect.arrayContaining([
      '--dsl-disclosure-title-font-size: var(--dsh-content-font-size, 14px)',
    ]))
  })
})
