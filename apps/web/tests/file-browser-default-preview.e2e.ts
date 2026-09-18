// Web e2e scenario: the file browser's default view for a previewable file — a
// workspace-row menu entry opens the dialog, and picking a Markdown file lands
// on the rendered document with the preview switch already on, while a file
// whose extension names no preview kind still lands in the editor.
//
// Zero model calls: this is the browser's own content pane over host file
// RPCs, with no session or model involvement.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, newEnglishPage, saveFailureShot } from './support.ts'

/** The heading the staged Markdown file renders, absent its `#`. */
const MD_HEADING = 'Heading from default preview'

describe('web e2e: file browser default preview', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // The dialog's copy is locale-owned and this lane pins Chinese, so the
    // workspace connect below takes the localized picker.
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    const workspace = join(scaffold.workspaceCwd, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'NOTES.md'), `# ${MD_HEADING}\n\n| a | b |\n| - | - |\n| 1 | 2 |\n`)
    writeFileSync(join(workspace, 'plain.txt'), 'plain text body\n')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 180_000)

  afterAll(async () => {
    await browser?.close().catch(() => {})
    await scaffold?.close().catch(() => {})
  })

  it('renders a Markdown file on open and leaves a plain text file in the editor', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-browser-default-preview'))
    // The workspace row's own menu is the file browser's only entry.
    await page.getByText('workspace', { exact: true }).first().hover()
    await page.getByLabel('工作区“workspace”的操作').first().click()
    await page.getByRole('menuitem', { name: '🗂️ 文件浏览器' }).click()

    const dialog = page.getByRole('dialog', { name: /文件浏览器/ })
    await dialog.waitFor({ timeout: 15_000 })
    await dialog.getByText('NOTES.md', { exact: true }).click()

    // Opening is the whole gesture: the heading and the GFM table are on screen,
    // which only the rendered document produces, and the switch says so.
    await dialog.getByRole('heading', { level: 1, name: MD_HEADING }).waitFor({ timeout: 15_000 })
    await expect.poll(() => dialog.getByRole('table').count(), { timeout: 15_000 }).toBe(1)
    expect(await dialog.getByRole('checkbox', { name: '预览' }).isChecked()).toBe(true)
    // The source is what the switch leads to, not what opened.
    expect(await dialog.locator('textarea[aria-label="NOTES.md"]').count()).toBe(0)

    // A file with no preview kind is unaffected: it still opens in the editor.
    await dialog.getByText('plain.txt', { exact: true }).click()
    await dialog.locator('textarea[aria-label="plain.txt"]').waitFor({ timeout: 15_000 })
    expect(await dialog.getByRole('checkbox', { name: '预览' }).count()).toBe(0)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
