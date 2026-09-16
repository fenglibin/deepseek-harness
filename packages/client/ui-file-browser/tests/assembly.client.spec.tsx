// @vitest-environment jsdom
/**
 * The assembled chain a product user actually walks: ui-workspace's row menu →
 * the contributed "文件浏览器" entry → the file-browser dialog over
 * `ctx.remote.fileBrowser`.
 *
 * Both plugins run their real `apply` here — the contribution rides the real
 * `ctx.workspaceRowMenu` registry rather than a stub — and a FakeRemote answers
 * the workspace namespace. Unloading the browser plugin is asserted too: the
 * entry is a registry contribution, so disposing its fiber must take the menu
 * row and the overlay registration with it.
 *
 * The dialog's own arms live in file-browser.client.spec.tsx, and the
 * workspace-scoped filesystem contract in the Host package's suite; this file
 * owns only the wiring between them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { FileBrowserRemote } from '@deepseek-ai/dsh-client-ui-file-browser/client'
import { SlotTestRuntime, TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyWorkspace, inject as injectWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { apply as applyFileBrowser, inject as injectFileBrowser } from '@deepseek-ai/dsh-client-ui-file-browser/client'

// The services read their initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const WID = 'w1' as WorkspaceId
const SESSION_ID = 'session-1' as never

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** The workspace listing the row menu is built from. */
const workspaceRow = {
  workspaceId: WID,
  title: 'alpha',
  path: '/w/alpha',
  sessionIds: [SESSION_ID],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/**
 * Mount ui-workspace plus the file browser over a FakeRemote. `fileBrowser`
 * records its requests so the assertions can see the dialog's first listing.
 */
async function mountComposition() {
  const runtime = await SlotTestRuntime.create()
  runtime.releaseWorkspaceSource()
  const openWorkspacePath = vi.fn((_request: { path: string }) => Promise.resolve({ ok: true as const, value: { opened: true as const } }))
  const openWorkspace = { openWorkspacePath }
  const fileBrowser: FileBrowserRemote & { calls: string[] } = Object.assign({
    list: (request: { path?: string }) => {
      fileBrowser.calls.push(`list:${request.path ?? ''}`)
      return Promise.resolve({
        ok: true as const,
        value: { path: request.path ?? '', entries: [{ name: 'README.md', path: 'README.md', kind: 'file' as const }], truncated: false },
      })
    },
    read: (request: { path: string }) => {
      fileBrowser.calls.push(`read:${request.path}`)
      return Promise.resolve({
        ok: true as const,
        value: { kind: 'text' as const, text: '# hi', version: 'v1', size: 4 },
      })
    },
    write: () => Promise.resolve({ ok: true as const, value: { version: 'v2' } }),
    create: () => Promise.resolve({ ok: true as const, value: { path: 'new.txt' } }),
    rename: () => Promise.resolve({ ok: true as const, value: { path: 'renamed.txt' } }),
    delete: () => Promise.resolve({ ok: true as const, value: undefined }),
    search: () => Promise.resolve({ ok: true as const, value: { matches: [], truncated: false } }),
  }, { calls: [] as string[] })
  // One TestRemote registers ctx.remote plus a service per scripted namespace,
  // so both plugins' inject declarations unpark.
  // `remote.session` is scripted because the viewer's desktop opener calls
  // `openWorkspacePath` on it; a namespace this assembly does not provide is
  // exactly what leaves that action a silent no-op.
  new TestRemote(runtime.ctx, { fileBrowser, directoryPicker: {}, session: openWorkspace })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  // ui-workspace's navigation policy lazily creates a blank Session when it
  // restores a Workspace selection; nothing in this chain needs one, so it is
  // stubbed to keep the automatic selection quiet.
  runtime.sessions.stubCreate(async () => 'stub-session' as never)
  await runtime.workspaces.update((draft) => {
    draft.items = [workspaceRow] as never
  })
  await runtime.root.declare(
    // The real composition has ui-layout declaring both seats; this test owns
    // the shell role instead, so it declares and renders exactly the two holes
    // the chain needs: the browsing region and the frame-wide overlay the
    // dialog lands in.
    {
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    } as never,
    ShellFrame as never,
  )
  return { runtime, fileBrowser, openWorkspacePath }
}

/** Test-owned shell role: declares and renders the browsing region plus the overlay layer. */
function ShellFrame({ renderSlot }: { renderSlot: (name: string, owner: object) => React.ReactNode }) {
  return (
    <>
      {renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}
      {renderSlot('shell.overlay', {})}
    </>
  )
}

/**
 * The contributed entry's shipped label, icon included: a row's accessible name
 * is its rendered text, so the icon is part of what this assembly asserts.
 */
const MENU_OPEN_LABEL = '🗂️ 文件浏览器'

describe('workspace file browser through the assembled browser', () => {
  /**
   * Mount both plugins the way a deployment composes them. ui-workspace goes
   * first because it provides `workspaceRowMenu`, the service the browser
   * plugin injects; the returned fiber is the browser plugin's, so a test can
   * dispose exactly that contribution.
   */
  async function mountBoth() {
    const harness = await mountComposition()
    await harness.runtime.mount({ inject: [...injectWorkspace], apply: applyWorkspace })
    const browserFiber = await harness.runtime.mount({
      inject: [...injectFileBrowser],
      apply: applyFileBrowser,
    })
    return { ...harness, browserFiber }
  }

  it('the row menu carries the contributed entry that ui-workspace did not write', async () => {
    const { runtime } = await mountBoth()
    const view = runtime.renderRoot()
    const row = (await view.findByText('alpha')).closest('[role="treeitem"]') as HTMLElement
    fireEvent.click(within(row).getByLabelText('工作区“alpha”的操作'))
    expect(await view.findByRole('menuitem', { name: MENU_OPEN_LABEL, hidden: true })).toBeTruthy()
    // The built-in verbs keep their places around the contribution.
    expect(view.getByRole('menuitem', { name: '重命名', hidden: true })).toBeTruthy()
    expect(view.getByRole('menuitem', { name: '删除工作区', hidden: true })).toBeTruthy()
    await runtime.dispose()
  })

  it('clicking the entry opens the dialog over the requested workspace', async () => {
    const { runtime, fileBrowser } = await mountBoth()
    const view = runtime.renderRoot()
    const row = (await view.findByText('alpha')).closest('[role="treeitem"]') as HTMLElement
    fireEvent.click(within(row).getByLabelText('工作区“alpha”的操作'))
    fireEvent.click(await view.findByRole('menuitem', { name: MENU_OPEN_LABEL, hidden: true }))

    // The dialog lands and lists the requested Workspace's root.
    await view.findByRole('dialog', { name: /文件浏览器/ })
    await waitFor(() => { expect(fileBrowser.calls).toContain('list:') })
    expect(await view.findByText('README.md')).toBeTruthy()
    await runtime.dispose()
  })

  it('opens a session file link as a read-only view through ctx.fileViewer', async () => {
    const { runtime, fileBrowser } = await mountBoth()
    const view = runtime.renderRoot()

    // The face a sibling plugin reaches: a session whose Workspace is known.
    const viewer = runtime.ctx.get('fileViewer')
    expect(viewer).toBeDefined()
    expect(viewer?.open({ sessionId: SESSION_ID, path: 'src/main.ts' })).toEqual({ kind: 'opened' })

    await view.findByRole('dialog', { name: /文件浏览器/ })
    await waitFor(() => { expect(fileBrowser.calls).toContain('read:src/main.ts') })
    // The editor renders the buffer into its textarea; the highlight layer
    // carries the same text as token spans.
    const editor = await view.findByDisplayValue('# hi')
    expect(editor).toBeTruthy()
    expect(view.getByText('只读')).toBeTruthy()
    // The link is a request to look: no edit affordance, and no tree listing.
    expect(view.queryByText('保存')).toBeNull()
    expect(fileBrowser.calls.some(call => call.startsWith('list:'))).toBe(false)
    await runtime.dispose()
  })

  it('hands the viewed path to the desktop opener when the operator asks for it', async () => {
    const { runtime, openWorkspacePath } = await mountBoth()
    const view = runtime.renderRoot()

    runtime.ctx.get('fileViewer')?.open({ sessionId: SESSION_ID, path: 'src/main.ts' })
    await view.findByRole('dialog', { name: /文件浏览器/ })
    fireEvent.click(await view.findByText('用本地编辑器打开'))

    // The opener resolves against the Host process's own cwd, so the viewed
    // workspace-relative path must arrive rebased onto the Workspace root.
    await waitFor(() => {
      expect(openWorkspacePath).toHaveBeenCalledWith({ path: '/w/alpha/src/main.ts' })
    })
    await runtime.dispose()
  })

  it('keeps the close control in the same toolbar seat in both modes', async () => {
    const { runtime } = await mountBoth()
    const view = runtime.renderRoot()

    runtime.ctx.get('fileViewer')?.open({ sessionId: SESSION_ID, path: 'src/main.ts' })
    await view.findByRole('dialog', { name: /文件浏览器/ })
    // The right-hand group owns the far-right seat; the close button is its
    // last child in the file mode too, so it never trails a secondary action.
    const group = view.getByLabelText('关闭').parentElement
    expect(group?.lastElementChild).toBe(view.getByLabelText('关闭'))
    await runtime.dispose()
  })

  it('reports a session with no Workspace instead of opening the desktop', async () => {
    const { runtime } = await mountBoth()
    const view = runtime.renderRoot()

    const viewer = runtime.ctx.get('fileViewer')
    expect(viewer?.open({ sessionId: 'unowned-session' as never, path: 'src/main.ts' }))
      .toEqual({ kind: 'no-workspace' })

    expect(await view.findByText('该会话不属于任何工作区，无法在此查看文件。')).toBeTruthy()
    await runtime.dispose()
  })

  it('unloading the browser plugin withdraws its entry and its dialog', async () => {
    const { runtime, browserFiber } = await mountBoth()
    const view = runtime.renderRoot()
    const row = (await view.findByText('alpha')).closest('[role="treeitem"]') as HTMLElement
    fireEvent.click(within(row).getByLabelText('工作区“alpha”的操作'))
    await view.findByRole('menuitem', { name: MENU_OPEN_LABEL, hidden: true })
    // Close the menu so the surviving-verbs assertion below reopens it cleanly.
    fireEvent.keyDown(document, { key: 'Escape' })

    await browserFiber.dispose()
    await runtime.flush()

    fireEvent.click(within(row).getByLabelText('工作区“alpha”的操作'))
    // The contributed row is gone; the built-in verbs survive it.
    expect(view.queryByRole('menuitem', { name: MENU_OPEN_LABEL, hidden: true })).toBeNull()
    expect(view.getByRole('menuitem', { name: '重命名', hidden: true })).toBeTruthy()
    await runtime.dispose()
  })
})
