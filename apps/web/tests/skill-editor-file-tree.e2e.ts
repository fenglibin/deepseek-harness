// Web e2e scenario: the geometry of the skill editor's file tree. A nested file
// used to share a line with the directory that holds it, and only a browser can
// settle whether it does: jsdom measures no layout, while the shape that decides
// it — every row a flex item of the tree's column — is asserted in
// packages/client/ui-settings-skills/tests/skill-file-tree.client.spec.tsx.
// A row also has to fill the pane rather than shrink-wrap its own text, or the
// selected file's fill stops short of the sidebar's edge.
//
// Zero model calls: opening Settings and the editor reads the Host's skill
// roots, the entry, and one file, so there is no fixture and a stray stream
// would fail loud on the open llm seam.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

/** The skill the scenario seeds into the global root. */
const SKILL_NAME = 'tree-fixture'
/** The nested file the editor opens; its directory is the row the bug paired it with. */
const NESTED_FILE = 'scripts/find-sessions.sh'
/** Label the editor's sidebar carries, which is how the tree is addressed. */
const TREE_LABEL = '文件'

/** One row of the editor's file tree, as the browser laid it out and rounded to whole pixels. */
interface RowBox {
  readonly text: string
  readonly top: number
  readonly bottom: number
  readonly width: number
}

/** The editor's file tree sidebar. */
function treeOf(page: Page): Locator {
  return page.locator(`aside[aria-label="${TREE_LABEL}"]`)
}

/**
 * Measure every row of the tree in document order.
 * @param page - the page under test.
 * @returns one box per row.
 */
async function measureRows(page: Page): Promise<RowBox[]> {
  return await treeOf(page).evaluate(aside => [...aside.querySelectorAll('button')].map((row) => {
    const rect = row.getBoundingClientRect()
    // Rounded on both edges: adjacent rows are contiguous, so the same edge
    // rounded twice compares equal instead of off by a fraction.
    return {
      text: (row.textContent ?? '').trim(),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
    }
  }))
}

/**
 * The one row carrying a label.
 * @param rows - the measured rows.
 * @param text - the row's own text, prefix included.
 * @returns the row.
 */
function rowOf(rows: readonly RowBox[], text: string): RowBox {
  const found = rows.find(row => row.text === text)
  if (found === undefined) {
    throw new Error(`no file tree row named ${text}; measured ${rows.map(row => row.text).join(', ')}`)
  }
  return found
}

/**
 * Put the rows back into an ordinary block flow for one measurement: a block
 * container holding inline-block buttons is what a per-directory wrapper
 * produces, and it is the shape the report saw. The container is widened so the
 * rows have the room the sidebar can take away from them, since a line break
 * forced by a narrow pane would not be the bug.
 * @param page - the page under test.
 */
async function breakColumnIntoInlineFlow(page: Page): Promise<void> {
  await treeOf(page).evaluate((aside) => {
    const container = aside.firstElementChild as HTMLElement
    container.style.display = 'block'
    container.style.width = '480px'
    for (const row of container.querySelectorAll('button')) row.style.display = 'inline-block'
  })
}

/**
 * Lift the control, leaving the depth custom properties React owns in place.
 * @param page - the page under test.
 */
async function restoreColumn(page: Page): Promise<void> {
  await treeOf(page).evaluate((aside) => {
    const container = aside.firstElementChild as HTMLElement
    container.style.removeProperty('display')
    container.style.removeProperty('width')
    for (const row of container.querySelectorAll('button')) row.style.removeProperty('display')
  })
}

/**
 * Seed one directory-package skill with a nested directory under the global
 * agents root the scaffold pinned inside its temp world.
 * @param workspaceCwd - the scaffold's temp workspace.
 */
async function seedSkill(workspaceCwd: string): Promise<void> {
  const directory = join(workspaceCwd, '.agents-home', 'skills', SKILL_NAME)
  await mkdir(join(directory, 'scripts', 'lib'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${SKILL_NAME}`,
    'description: Prove that every row of the editor file tree takes its own line',
    '---',
    '',
    'Read the scripts under this directory when asked.',
    '',
  ].join('\n'))
  await writeFile(join(directory, NESTED_FILE), '#!/bin/sh\necho find-sessions\n')
  await writeFile(join(directory, 'scripts', 'wait-for-text.sh'), '#!/bin/sh\necho wait-for-text\n')
  await writeFile(join(directory, 'scripts', 'lib', 'helper.sh'), '#!/bin/sh\necho helper\n')
}

describe('web e2e: skill editor file tree geometry', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSkill(scaffold.workspaceCwd)
    browser = await chromium.launch()
    // The section's copy is Chinese-only, so the page advertises zh-CN: an
    // English browser would resolve the labels this scenario anchors on
    // through a fallback the product does not ship.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('button', { name: '技能', exact: true }).click()
    const row = settings.locator('li').filter({ hasText: SKILL_NAME })
    await row.waitFor({ timeout: 15_000 })
    await row.getByRole('button', { name: '编辑' }).click()

    const editor = page.getByRole('dialog', { name: `编辑 ${SKILL_NAME}` })
    await editor.waitFor({ timeout: 10_000 })
    await treeOf(page).locator('button').first().waitFor({ timeout: 15_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('gives every row its own line, nested files included', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-editor-file-tree-rows'))
    const rows = await measureRows(page)

    expect(rows.map(row => row.text)).toEqual([
      'SKILL.md',
      '▾ scripts',
      'find-sessions.sh',
      'wait-for-text.sh',
      '▾ lib',
      'helper.sh',
    ])
    // The reported symptom as a number: the file the reader came to open sat on
    // the same line as the directory holding it, so their vertical ranges
    // overlapped. One row per line means distinct tops in document order.
    expect(rows.map(row => row.top)).toEqual([...rows.map(row => row.top)].sort((left, right) => left - right))
    expect(new Set(rows.map(row => row.top)).size).toBe(rows.length)
    const directory = rowOf(rows, '▾ scripts')
    expect(rowOf(rows, 'find-sessions.sh').top).toBeGreaterThanOrEqual(directory.bottom)
    // Depth only indents the text, so a nested row spans the same pane a
    // top-level one does — an inline-block row would shrink-wrap its own name.
    expect(new Set(rows.map(row => row.width)).size).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('fills the pane with the row of a nested file the reader opens', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-editor-file-tree-selection'))
    const before = await measureRows(page)
    const nested = rowOf(before, 'find-sessions.sh')

    await treeOf(page).getByRole('button', { name: 'find-sessions.sh', exact: true }).click()
    // The selection is only real once the Host read lands: the editor shows the
    // bytes the scenario seeded on disk.
    await expect.poll(async () => await page.locator('textarea').inputValue(), { timeout: 15_000 })
      .toContain('find-sessions')

    const selected = await treeOf(page).locator('[aria-current="true"]').evaluate((row) => {
      const rect = row.getBoundingClientRect()
      return { text: (row.textContent ?? '').trim(), width: Math.round(rect.width) }
    })
    expect(selected.text).toBe('find-sessions.sh')
    expect(selected.width).toBe(nested.width)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('shares lines again once the rows are put back into an inline flow', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-editor-file-tree-control'))
    // The control. Distinct tops could also mean the tree never laid out at
    // all, so the shape that produced the report is restored in the page: a
    // block container whose inline-block rows flow beside each other.
    await breakColumnIntoInlineFlow(page)
    const broken = await measureRows(page)
    expect(new Set(broken.map(row => row.top)).size).toBeLessThan(broken.length)

    // Restoring the column restores the one-row-per-line measure, so the
    // control cannot leak into the rows the other cases read.
    await restoreColumn(page)
    const restored = await measureRows(page)
    expect(new Set(restored.map(row => row.top)).size).toBe(restored.length)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
