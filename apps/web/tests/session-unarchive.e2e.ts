// Web e2e 场景：已归档会话经设置页、真实线路与一次重载完成恢复——从行菜单归档，
// 经归档集合与页面，再到由 Host 基线重建状态的重载。零模型调用：两个动词都是
// Host RPC，页面只读已加载的 Session 摘要，因此不挂载任何回放夹具，一旦有模型流
// 漏进来就会大声失败。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

// 种子复用另一个场景已提交的夹具（只读）：本 spec 只需要任意一个冷 Session 行，
// 不产生新的录制内容。
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.jsonl', import.meta.url))
const SEED_ID = 'session-unarchive-web-e2e'

describe('web e2e: 已归档会话从设置页恢复', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /**
   * 展开渲染为折叠态的未分组分组，使其行可被寻址，然后返回承载它们的分区。
   * @returns 已展开的未分组分区定位器。
   */
  async function ungroupedSection(): Promise<Locator> {
    const header = page.getByText('未分组', { exact: true })
    const groupRow = header.locator('..').locator('..')
    await expect.poll(async () => {
      if (await groupRow.count() === 0) return 'absent'
      if (await groupRow.getAttribute('aria-expanded') !== 'true') {
        await header.click()
        return 'collapsed'
      }
      return 'expanded'
    }, { timeout: 15_000 }).toBe('expanded')
    return groupRow.locator('..')
  }

  /**
   * 显出并点击一个行内操作；若投影更新替换了该行，则重新悬停直到按钮可见。
   * @param row - 持有该操作的行。
   * @param name - 操作按钮的无障碍名称。
   */
  async function clickHoverAction(row: Locator, name: string): Promise<void> {
    const button = row.getByRole('button', { name })
    await expect.poll(async () => {
      await row.hover()
      return await button.isVisible()
    }, { timeout: 10_000 }).toBe(true)
    await button.click()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // 播下一个冷会话；没有注册任何 Workspace 时，它是侧边栏唯一的一行，落在未分组桶中。
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    // 本场景断言的是产品中文文案，因此让浏览器声明中文。
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('归档种子会话，从设置页取消归档，并在重载后保持已恢复', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-unarchive'))
    // 选中唯一可见的 Session，再给它一个用户标题：两侧的定位器都绑定到种子自己的副本。
    const seededRow = (await ungroupedSection()).locator('[role="treeitem"]')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
    await expect.poll(() => seededRow.count(), { timeout: 10_000 }).toBe(1)
    await seededRow.click()
    await expect.poll(() => seededRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')
    const { title } = await scaffold.ctx.sessionController.rename({
      sessionId: SessionId(SEED_ID), title: `Unarchive target ${SEED_ID}`,
    })
    const sessionRow = page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => sessionRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    // 从行菜单归档：没有确认对话框；失去最后一个可见 Session 会撤下整个未分组桶。
    await clickHoverAction(sessionRow, `Session actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByText('未分组', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    // 在 Host 上持久：注册表全局集合持有该 id，而 Session 日志本身仍未被动过。
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([SessionId(SEED_ID)])
    expect((await scaffold.ctx.sessionPersistence.list()).map(header => header.id))
      .toContain(SessionId(SEED_ID))

    // 设置页在自己的搜索框后列出这个已归档 Session。
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '已归档会话' }).click()
    const search = dialog.getByRole('searchbox', { name: '搜索已归档会话' })
    await search.waitFor({ timeout: 10_000 })
    const unarchiveRow = dialog.getByRole('button', { name: `取消归档 ${title}` })
    await expect.poll(() => unarchiveRow.count(), { timeout: 10_000 }).toBe(1)
    expect(await dialog.getByText(title, { exact: true }).count()).toBe(1)
    expect(await dialog.getByText(/^未分组 · /).count()).toBe(1)
    expect(await dialog.getByText('暂无已归档会话。', { exact: true }).count()).toBe(0)
    // 搜索框在两个方向上都过滤这些行。
    await search.fill('zzz-no-such-archived-session')
    await expect.poll(
      () => dialog.getByText('没有匹配的会话。', { exact: true }).count(),
      { timeout: 5_000 },
    ).toBe(1)
    expect(await unarchiveRow.count()).toBe(0)
    await search.fill(title)
    await expect.poll(() => unarchiveRow.count(), { timeout: 5_000 }).toBe(1)
    expect(await dialog.getByText('没有匹配的会话。', { exact: true }).count()).toBe(0)
    await search.fill('')
    await expect.poll(() => unarchiveRow.count(), { timeout: 5_000 }).toBe(1)

    // 取消归档：持久集合清空（该行自己的 RPC），页面行带着空态离开，Session 行回到侧边栏。
    await unarchiveRow.click()
    await expect.poll(
      () => [...scaffold.ctx.workspaceRegistry.archivedSessionIds],
      { timeout: 10_000 },
    ).toEqual([])
    await expect.poll(() => unarchiveRow.count(), { timeout: 10_000 }).toBe(0)
    expect(await dialog.getByText(title, { exact: true }).count()).toBe(0)
    await expect.poll(
      () => dialog.getByText('暂无已归档会话。', { exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(1)
    await dialog.getByRole('button', { name: '关闭' }).last().click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await ungroupedSection()
    await expect.poll(() => sessionRow.count(), { timeout: 15_000 }).toBe(1)

    // 重载：恢复的行由 Host 基线重建，因此取消归档是持久的，而不只是客户端状态。
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await ungroupedSection()
    await expect.poll(() => sessionRow.count(), { timeout: 15_000 }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
