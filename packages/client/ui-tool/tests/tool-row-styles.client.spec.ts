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

/** One output stage; the selector's brackets are escaped, not a character class. */
function stageDeclarations(stage: string): string[] {
  const rule = new RegExp(
    `\\.terminalWrap\\[data-stage='${stage}'\\] \\.terminal\\s*\\{([^{}]*)\\}`,
  ).exec(bashDeclarationText)
  if (rule === null) throw new Error(`bash-sample.module.css has no '${stage}' stage rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('bash row output-height stages', () => {
  it('caps the closed row at two lines and the open row at ten', () => {
    expect(stageDeclarations('peek')).toEqual([
      '--dsl-terminal-output-max-height: calc(var(--dsl-terminal-line-height) * 2)',
    ])
    expect(stageDeclarations('full')).toEqual([
      '--dsl-terminal-output-max-height: calc(var(--dsl-terminal-line-height) * 10)',
    ])
  })

  it('derives both caps from the line height the row binds, never a copied px value', () => {
    // A cap written in px would drift from the terminal's own line height the
    // moment that binding changed, leaving the row showing half a line.
    expect(bashDeclarations('.terminal')).toEqual(expect.arrayContaining([
      '--dsl-terminal-line-height: 18px',
    ]))
    for (const stage of ['peek', 'full']) {
      expect(stageDeclarations(stage).join(';')).toContain('var(--dsl-terminal-line-height)')
    }
  })

  it('hides the closed preview\'s scrollbars and keeps them on the open stages', () => {
    // A two-line thumb is too small to drag and crowds the lines it sits
    // beside; the open stages are where scrolling is meant to happen.
    expect(bashDeclarationText).toContain(
      ".terminalWrap[data-stage='peek'] .terminal ::-webkit-scrollbar",
    )
    const peek = /\.terminalWrap\[data-stage='peek'\] \.terminal \*\s*\{([^{}]*)\}/.exec(bashDeclarationText)
    expect((peek?.[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)).toEqual([
      'scrollbar-width: none',
    ])
  })

  it('leaves the unbounded stage without a cap', () => {
    // The primitive reads `none` by default, so the overflow never engages.
    for (const stage of ['peek', 'full']) {
      expect(bashDeclarations('.terminal')).not.toEqual(expect.arrayContaining([
        '--dsl-terminal-output-max-height: none',
      ]))
      expect(stageDeclarations(stage).join(';')).not.toContain('none')
    }
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

  it('sizes the summary texts from the secondary content tier', () => {
    // The Settings font-size preference must reach tool-call rows, not only
    // the narration body: summary, suffix, and file link read the secondary
    // tier (one step under the body), matching think text.
    for (const selector of ['.summary', '.summarySuffix', '.fileLink']) {
      expect(declarations(selector)).toEqual(expect.arrayContaining([
        'font-size: var(--dsh-content-font-size-secondary, 13px)',
        'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
      ]))
    }
  })
})
