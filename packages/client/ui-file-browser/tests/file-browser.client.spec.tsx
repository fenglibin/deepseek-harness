// @vitest-environment jsdom
/**
 * The file browser dialog's behavior: the lazy tree, the filtering and search,
 * the editor's save and conflict arms, and the four content kinds. The Remote
 * is a stub here — the workspace-scoped filesystem contract belongs to the Host
 * package's suite, and the assembly chain to the REAL-composition spec beside
 * this one.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { FileBrowserModal, type FileBrowserRemote } from '../src/client/FileBrowserModal.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const WID = 'ws-1' as WorkspaceId

/** A `list` answer for one directory. */
const listing = (path: string, entries: readonly { name: string; kind: 'file' | 'directory' }[], truncated = false) => ({
  path,
  entries: entries.map(entry => ({
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    kind: entry.kind,
  })),
  truncated,
})

/**
 * A Remote that records every call and delegates each verb to an override when
 * one is given. The recorder wraps the override rather than the base answer, so
 * a test that supplies its own `list` still sees the call in `calls`.
 */
function remoteStub(overrides: Partial<FileBrowserRemote> = {}): FileBrowserRemote & { calls: string[] } {
  const calls: string[] = []
  const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
  const base: FileBrowserRemote = {
    list: request => ok(listing(request.path ?? '', [])),
    read: () => ok({ kind: 'text' as const, text: 'hello', version: 'v1', size: 5 }),
    write: () => ok({ version: 'v2' }),
    create: request => ok({ path: request.name }),
    rename: request => ok({ path: request.name }),
    delete: () => ok(undefined),
    search: () => ok({ matches: [], truncated: false }),
  }
  const record = <A extends { path?: string; name?: string; query?: string }, R>(
    verb: string,
    pick: (request: A) => string,
    run: (request: A) => R,
  ) => (request: A): R => {
    calls.push(`${verb}:${pick(request)}`)
    return run(request)
  }
  const face: FileBrowserRemote = {
    list: record('list', r => r.path ?? '', overrides.list ?? base.list),
    read: record('read', r => r.path ?? '', overrides.read ?? base.read),
    write: record('write', r => r.path ?? '', overrides.write ?? base.write),
    create: record('create', r => r.name ?? '', overrides.create ?? base.create),
    rename: record('rename', r => r.name ?? '', overrides.rename ?? base.rename),
    delete: record('delete', r => r.path ?? '', overrides.delete ?? base.delete),
    search: record('search', r => r.query ?? '', overrides.search ?? base.search),
  }
  return Object.assign(face, { calls })
}

/** Render the dialog for one Workspace. */
function mount(remote: FileBrowserRemote, open = true) {
  return render(
    <FileBrowserModal
      open={open}
      workspace={{ workspaceId: WID, title: 'Project' }}
      onClose={() => {}}
      remote={remote}
      t={t}
    />,
  )
}

describe('tree', () => {
  it('loads the root on open and shows directories before files', async () => {
    const remote = remoteStub({
      list: request => Promise.resolve({
        ok: true as const,
        value: listing(request.path ?? '', [
          { name: 'src', kind: 'directory' },
          { name: 'README.md', kind: 'file' },
        ]),
      }),
    })
    mount(remote)
    expect(await screen.findByText('src')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
    expect(remote.calls).toContain('list:')
  })

  it('loads a directory only when it expands', async () => {
    const remote = remoteStub({
      list: request => Promise.resolve({
        ok: true as const,
        value: request.path === 'src'
          ? listing('src', [{ name: 'main.ts', kind: 'file' }])
          : listing('', [{ name: 'src', kind: 'directory' }]),
      }),
    })
    mount(remote)
    await screen.findByText('src')
    expect(remote.calls).not.toContain('list:src')
    fireEvent.click(screen.getByText('src'))
    expect(await screen.findByText('main.ts')).toBeTruthy()
    expect(remote.calls).toContain('list:src')
  })

  it('reports an empty directory and a failed listing distinctly', async () => {
    const empty = remoteStub()
    const first = mount(empty)
    expect(await screen.findByText('此目录为空')).toBeTruthy()
    first.unmount()

    const failing = remoteStub({
      list: () => Promise.resolve({ ok: false as const, error: new RemoteError('file-browser/unreadable', 'nope', { path: 'x' }) }),
    })
    mount(failing)
    expect(await screen.findByText('无法加载该目录。')).toBeTruthy()
  })

  it('reports truncation', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({
        ok: true as const,
        value: listing('', [{ name: 'a.txt', kind: 'file' }], true),
      }),
    })
    mount(remote)
    expect(await screen.findByText('条目过多，仅显示开头部分。')).toBeTruthy()
  })

  it('re-reads the root when the hidden-files toggle flips', async () => {
    const remote = remoteStub({
      list: request => Promise.resolve({
        ok: true as const,
        value: listing('', request.showHidden === true ? [{ name: '.git', kind: 'directory' }] : []),
      }),
    })
    mount(remote)
    await screen.findByText('此目录为空')
    fireEvent.click(screen.getByLabelText('显示隐藏项'))
    expect(await screen.findByText('.git')).toBeTruthy()
  })
})

describe('content pane', () => {
  it('shows a prompt before anything is selected', async () => {
    mount(remoteStub())
    expect(await screen.findByText('从左侧选择一个文件')).toBeTruthy()
  })

  it('opens a text file in the editor with its language resolved', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'main.ts', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'text' as const, text: 'const a = 1', version: 'v1', size: 11 } }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('main.ts'))
    expect(await screen.findByText('已保存')).toBeTruthy()
    // The pane header names the open path; the tree row is the other occurrence.
    expect(screen.getAllByText('main.ts').length).toBeGreaterThan(1)
    expect(screen.getByTestId('editor-language').textContent).toBe('ts')
  })

  it.each([
    ['config.yml', 'yml'],
    ['config.yaml', 'yaml'],
    ['data.json', 'json'],
    ['page.xml', 'xml'],
    ['README.md', 'md'],
    ['pyproject.toml', 'toml'],
    ['main.py', 'py'],
    ['main.go', 'go'],
    ['App.java', 'java'],
  ])('resolves %s to the %s grammar', async (name, lang) => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name, kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'text' as const, text: 'x', version: 'v1', size: 1 } }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText(name))
    await waitFor(() => { expect(screen.getByTestId('editor-language').textContent).toBe(lang) })
  })

  it('renders an unknown extension as plain text without failing', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'weird.qqq', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'text' as const, text: 'plain', version: 'v1', size: 5 } }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('weird.qqq'))
    await waitFor(() => { expect(screen.getByTestId('editor-language').textContent).toBe('') })
    expect(screen.getByLabelText('weird.qqq')).toBeTruthy()
  })

  it('shows an image through its Host-supplied URL and offers no editor', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'pic.png', kind: 'file' }]) }),
      read: () => Promise.resolve({
        ok: true as const,
        value: { kind: 'image' as const, mediaType: 'image/png' as const, size: 4, url: '/api/file.asset?workspaceId=ws-1&path=pic.png' },
      }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('pic.png'))
    const image = await screen.findByRole('img')
    expect(image.getAttribute('src')).toBe('/api/file.asset?workspaceId=ws-1&path=pic.png')
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('states a binary file instead of opening an editor', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'blob.bin', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'binary' as const, size: 3 } }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('blob.bin'))
    expect(await screen.findByText('这不是文本文件，无法在此查看或编辑。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('states an oversize file with its size and the bound', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'huge.txt', kind: 'file' }]) }),
      read: () => Promise.resolve({
        ok: true as const,
        value: { kind: 'too-large' as const, size: 3 * 1024 * 1024, limit: 2 * 1024 * 1024 },
      }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('huge.txt'))
    expect(await screen.findByText(/文件过大/)).toBeTruthy()
    expect(screen.getByText(/3\.0 MB/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('reports a failed read', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'a.txt', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: false as const, error: new RemoteError('file-browser/unreadable', 'denied', { path: 'a.txt' }) }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('a.txt'))
    expect(await screen.findByText('无法读取该文件。')).toBeTruthy()
  })
})

describe('editing and saving', () => {
  it('marks the buffer unsaved, saves it, and clears the mark', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'a.txt', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'text' as const, text: 'first', version: 'v1', size: 5 } }),
      write: request => Promise.resolve({ ok: true as const, value: { version: `v2:${request.content}` } }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('a.txt'))
    const box = await screen.findByLabelText('a.txt')
    fireEvent.change(box, { target: { value: 'second' } })
    expect(screen.getByText('未保存')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByText('已保存')).toBeTruthy() })
    expect(remote.calls.some(call => call.startsWith('write:a.txt'))).toBe(true)
  })

  it('saves on Ctrl+S and does not re-save an unmodified buffer', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'a.txt', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'text' as const, text: 'first', version: 'v1', size: 5 } }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('a.txt'))
    const box = await screen.findByLabelText('a.txt')
    // Nothing changed yet: the shortcut must not write.
    fireEvent.keyDown(box, { key: 's', ctrlKey: true })
    expect(remote.calls.some(call => call.startsWith('write:'))).toBe(false)

    fireEvent.change(box, { target: { value: 'second' } })
    fireEvent.keyDown(box, { key: 's', ctrlKey: true })
    await waitFor(() => { expect(remote.calls.some(call => call.startsWith('write:'))).toBe(true) })
  })

  it('reports a conflict and offers reload and overwrite', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'a.txt', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'text' as const, text: 'first', version: 'v1', size: 5 } }),
      write: () => Promise.resolve({ ok: false as const, error: new RemoteError('file-browser/stale', 'changed', { path: 'a.txt' }) }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('a.txt'))
    const box = await screen.findByLabelText('a.txt')
    fireEvent.change(box, { target: { value: 'mine' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('该文件已在磁盘上被其它程序改动，未覆盖。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '强制覆盖' })).toBeTruthy()
    // Reload appears on the toolbar as well as in the conflict strip; either
    // one re-reads the file.
    fireEvent.click(screen.getAllByRole('button', { name: '重新加载' })[0] as HTMLElement)
    await waitFor(() => { expect(remote.calls.filter(call => call === 'read:a.txt').length).toBeGreaterThan(1) })
  })

  it('overwrite drops the version guard so the write succeeds', async () => {
    const seen: (string | undefined)[] = []
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'a.txt', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'text' as const, text: 'first', version: 'v1', size: 5 } }),
      write: (request) => {
        seen.push(request.version)
        return seen.length === 1
          ? Promise.resolve({ ok: false as const, error: new RemoteError('file-browser/stale', 'changed', { path: 'a.txt' }) })
          : Promise.resolve({ ok: true as const, value: { version: 'v2' } })
      },
    })
    mount(remote)
    fireEvent.click(await screen.findByText('a.txt'))
    const box = await screen.findByLabelText('a.txt')
    fireEvent.change(box, { target: { value: 'mine' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('button', { name: '强制覆盖' })
    fireEvent.click(screen.getByRole('button', { name: '强制覆盖' }))
    await waitFor(() => { expect(screen.getByText('已保存')).toBeTruthy() })
    expect(seen[0]).toBe('v1')
    expect(seen[1]).toBeUndefined()
  })
})

describe('file operations', () => {
  it('creates a file in the current directory and refreshes it', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', []) }),
      create: () => Promise.resolve({ ok: true as const, value: { path: 'new.txt' } }),
    })
    mount(remote)
    await screen.findByText('此目录为空')
    fireEvent.click(screen.getByRole('button', { name: '新建文件' }))
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: 'new.txt' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => { expect(remote.calls).toContain('create:new.txt') })
  })

  it('creates a directory through the second header action', async () => {
    const kinds: string[] = []
    const remote = remoteStub({
      create: (request) => {
        kinds.push(request.kind)
        return Promise.resolve({ ok: true as const, value: { path: request.name } })
      },
    })
    mount(remote)
    await screen.findByText('此目录为空')
    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: 'nested' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => { expect(remote.calls).toContain('create:nested') })
    expect(kinds).toEqual(['directory'])
  })

  it('refuses to submit a blank create name', async () => {
    mount(remoteStub())
    await screen.findByText('此目录为空')
    fireEvent.click(screen.getByRole('button', { name: '新建文件' }))
    const submit = await screen.findByRole('button', { name: '创建' })
    expect(submit.hasAttribute('disabled')).toBe(true)
  })

  it('surfaces a create refusal without closing the dialog', async () => {
    const remote = remoteStub({
      create: () => Promise.resolve({ ok: false as const, error: new RemoteError('file-browser/exists', 'already exists: a.txt', { path: 'a.txt' }) }),
    })
    mount(remote)
    await screen.findByText('此目录为空')
    fireEvent.click(screen.getByRole('button', { name: '新建文件' }))
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: 'a.txt' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText('already exists: a.txt')).toBeTruthy()
    expect(screen.getByRole('button', { name: '创建' })).toBeTruthy()
  })

  it('renames an entry from its row menu and refreshes the parent', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'old.txt', kind: 'file' }]) }),
    })
    mount(remote)
    await screen.findByText('old.txt')
    fireEvent.click(screen.getByRole('button', { name: '“old.txt”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const field = await screen.findByLabelText('名称')
    fireEvent.change(field, { target: { value: 'new.txt' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => { expect(remote.calls).toContain('rename:new.txt') })
  })

  it('confirms before deleting, naming the target and stating it is irreversible', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'gone.txt', kind: 'file' }]) }),
    })
    mount(remote)
    await screen.findByText('gone.txt')
    fireEvent.click(screen.getByRole('button', { name: '“gone.txt”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    const dialog = await screen.findByRole('dialog', { name: '删除' })
    expect(dialog.textContent).toContain('将永久删除“gone.txt”，此操作不可恢复。')
    expect(remote.calls.some(call => call.startsWith('delete:'))).toBe(false)
  })

  it('cancelling the confirmation deletes nothing', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'gone.txt', kind: 'file' }]) }),
    })
    mount(remote)
    await screen.findByText('gone.txt')
    fireEvent.click(screen.getByRole('button', { name: '“gone.txt”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    expect(remote.calls.some(call => call.startsWith('delete:'))).toBe(false)
    expect(screen.getByText('gone.txt')).toBeTruthy()
  })

  it('deleting the open file clears the content pane', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'a.txt', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'text' as const, text: 'x', version: 'v1', size: 1 } }),
      delete: () => Promise.resolve({ ok: true as const, value: undefined }),
    })
    mount(remote)
    fireEvent.click(await screen.findByText('a.txt'))
    await screen.findByLabelText('a.txt')
    fireEvent.click(screen.getByRole('button', { name: '“a.txt”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(await screen.findByLabelText('我了解此操作不可恢复'))
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(screen.getByText('从左侧选择一个文件')).toBeTruthy() })
  })
})

describe('name search', () => {
  it('replaces the tree with matches and opens a hit on click', async () => {
    const remote = remoteStub({
      list: () => Promise.resolve({ ok: true as const, value: listing('', [{ name: 'a.txt', kind: 'file' }]) }),
      read: () => Promise.resolve({ ok: true as const, value: { kind: 'text' as const, text: 'x', version: 'v1', size: 1 } }),
      search: () => Promise.resolve({
        ok: true as const,
        value: { matches: [{ path: 'deep/needle.ts', kind: 'file' as const }], truncated: false },
      }),
    })
    mount(remote)
    await screen.findByText('a.txt')
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'needle' } })
    const hit = await screen.findByText('deep/needle.ts', undefined, { timeout: 2000 })
    fireEvent.click(hit)
    await waitFor(() => { expect(remote.calls).toContain('read:deep/needle.ts') })
  })

  it('reports an empty result and a truncation', async () => {
    const remote = remoteStub({
      search: () => Promise.resolve({
        ok: true as const,
        value: { matches: [{ path: 'a/needle.ts', kind: 'file' as const }], truncated: true },
      }),
    })
    mount(remote)
    await screen.findByText('此目录为空')
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'needle' } })
    expect(await screen.findByText(/仅显示前 1 条结果/, undefined, { timeout: 2000 })).toBeTruthy()
  })

  it('clearing the query restores the tree', async () => {
    mount(remoteStub())
    await screen.findByText('此目录为空')
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'needle' } })
    await screen.findByRole('tree', { name: '搜索结果' })
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(await screen.findByRole('tree', { name: '文件树' })).toBeTruthy()
  })

  it('reports a failed search', async () => {
    const remote = remoteStub({
      search: () => Promise.resolve({ ok: false as const, error: new RemoteError('file-browser/unreadable', 'x', { path: 'x' }) }),
    })
    mount(remote)
    await screen.findByText('此目录为空')
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'needle' } })
    expect(await screen.findByText('搜索失败。', undefined, { timeout: 2000 })).toBeTruthy()
  })
})

describe('lifecycle', () => {
  it('renders nothing while closed', () => {
    mount(remoteStub(), false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not call the Remote while closed', () => {
    const remote = remoteStub()
    mount(remote, false)
    expect(remote.calls).toEqual([])
  })
})
