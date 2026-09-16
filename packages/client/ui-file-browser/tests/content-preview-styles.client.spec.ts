/**
 * The content pane's sizing and preview-sheet declarations as CSS text.
 *
 * jsdom has no layout, so these read the declarations that carry the two
 * user-visible fixes: the toolbar's search box and action buttons drop to the
 * size of the text beside them, and the HTML preview frame keeps a document's
 * own white sheet instead of the host theme's surface. The frame background is
 * the one that a rendered check caught: a page declaring no colours gets black
 * text from the UA stylesheet, so a dark-theme fill made the preview unreadable.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const modalCss = readFileSync(
  fileURLToPath(new URL('../src/client/FileBrowserModal.module.css', import.meta.url)), 'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')
const editorCss = readFileSync(
  fileURLToPath(new URL('../src/client/CodeEditor.module.css', import.meta.url)), 'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')
const previewCss = readFileSync(
  fileURLToPath(new URL('../src/client/ContentPreview.module.css', import.meta.url)), 'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')

/** The declarations of one rule, in source order. */
function declarations(css: string, selector: string): string[] {
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]():*+^$\\>]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(css)
  if (rule === null) throw new Error(`no \`${selector}\` rule in the sheet`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('toolbar sizing', () => {
  it('keeps the search box below the shared input atom and at the tree row size', () => {
    // The shared Input atom is 32px tall at 14px; this row is a dense toolbar,
    // so the box is scoped down to the height of the icon buttons beside it and
    // to the 13px the file-tree rows already use.
    expect(declarations(modalCss, '.search > :first-child')).toEqual(expect.arrayContaining([
      'height: 26px',
    ]))
    expect(declarations(modalCss, '.search input')).toEqual(expect.arrayContaining([
      'font-size: 13px',
    ]))
    expect(declarations(modalCss, '.search')).toEqual(expect.arrayContaining([
      'max-width: 260px',
    ]))
  })

  it('keeps the preview switch at the size of the status text it sits beside', () => {
    expect(declarations(editorCss, '.toggle')).toEqual(expect.arrayContaining([
      'font-size: 12px',
    ]))
  })
})

describe('HTML preview frame', () => {
  it('presents a document sheet rather than the host theme surface', () => {
    // A produced page usually declares no colours, so the UA stylesheet gives it
    // black text. Filling the frame with the dark theme's surface would paint
    // that text onto a dark background; the frame keeps a document's white sheet
    // in both themes, and the surrounding chrome still shows which theme is on.
    const frame = declarations(previewCss, '.frame')
    expect(frame).toEqual(expect.arrayContaining(['background: rgb(255 255 255)']))
    // A theme-following fill is the regression this asserts against.
    expect(frame.some(line => line.startsWith('background: var('))).toBe(false)
  })
})
