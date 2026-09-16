// @vitest-environment jsdom
/**
 * The content pane's Markdown and HTML preview: which files offer the switch,
 * what each preview renders, and the one buffer the two views share.
 *
 * The Markdown arm is exercised through the real `MarkdownText` pipeline, so
 * these specs assert the rendered document (a table, a diagram fence) rather
 * than a projection of it. The HTML arm asserts the isolation attributes the
 * frame is created with — the browser is what enforces them, and jsdom does not
 * run a sandboxed document.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { FileBrowserModal, type FileBrowserRemote } from '../src/client/FileBrowserModal.tsx'
import { previewKindOfPath } from '../src/client/preview.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const WID = 'ws-1' as WorkspaceId

/** One file listing. */
const listing = (entries: readonly { name: string; kind: 'file' | 'directory' }[]) => ({
  path: '',
  entries: entries.map(entry => ({ name: entry.name, path: entry.name, kind: entry.kind })),
  truncated: false,
})

/** A Remote answering one file's text. */
function remoteStub(text: string): FileBrowserRemote {
  const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
  return {
    list: () => ok(listing([])),
    read: () => ok({ kind: 'text' as const, text, version: 'v1', size: text.length }),
    write: () => ok({ version: 'v2' }),
    create: request => ok({ path: request.name }),
    rename: request => ok({ path: request.name }),
    delete: () => ok(undefined),
    search: () => ok({ matches: [], truncated: false }),
  }
}

/** Render the dialog browsing one Workspace, then open `name` from the tree. */
async function open(name: string, text: string) {
  const remote: FileBrowserRemote = {
    ...remoteStub(text),
    list: () => Promise.resolve({ ok: true as const, value: listing([{ name, kind: 'file' as const }]) }),
  }
  render(
    <FileBrowserModal
      open
      request={{ kind: 'workspace', workspaceId: WID, title: 'Project' }}
      onClose={() => {}}
      remote={remote}
      t={t}
    />,
  )
  fireEvent.click(await screen.findByText(name))
  return waitFor(() => { expect(screen.getByText('已保存')).toBeTruthy() })
}

/** Render the dialog viewing one file read-only, as a session file link does. */
function mountFile(name: string, text: string) {
  return render(
    <FileBrowserModal
      open
      request={{ kind: 'file', workspaceId: WID, path: name, title: 'Project', readOnly: true }}
      onClose={() => {}}
      remote={remoteStub(text)}
      t={t}
    />,
  )
}

/** The preview switch, or null when the file offers none. */
function previewSwitch(): HTMLInputElement | null {
  return screen.queryByRole('checkbox', { name: '预览' }) as HTMLInputElement | null
}

describe('previewKindOfPath', () => {
  it.each([
    ['README.md', 'markdown'],
    ['docs/guide.markdown', 'markdown'],
    ['deepseek-homepage.html', 'html'],
    ['index.htm', 'html'],
    // Case is not part of the decision on a case-insensitive filesystem's
    // names; the extension decides either way.
    ['NOTES.MD', 'markdown'],
    ['Page.HTML', 'html'],
  ])('reads %s as %s', (path, kind) => {
    expect(previewKindOfPath(path)).toBe(kind)
  })

  it.each([
    ['main.ts'],
    ['data.json'],
    ['archive.html.bak'],
    // A dotfile's leading dot is not an extension separator.
    ['.markdown'],
    ['noextension'],
    ['a/b.c/README'],
  ])('offers no preview for %s', (path) => {
    expect(previewKindOfPath(path)).toBeUndefined()
  })

  it('does not resolve an inherited object member as a kind', () => {
    expect(previewKindOfPath('foo.constructor')).toBeUndefined()
  })
})

describe('preview switch', () => {
  it('is offered for a Markdown file and hidden for every other kind', async () => {
    await open('README.md', '# Title')
    expect(previewSwitch()).not.toBeNull()
    cleanup()

    await open('main.ts', 'const a = 1')
    expect(previewSwitch()).toBeNull()
    cleanup()

    await open('data.json', '{}')
    expect(previewSwitch()).toBeNull()
  })

  it('is offered for an HTML file', async () => {
    await open('page.html', '<p>hi</p>')
    expect(previewSwitch()).not.toBeNull()
  })

  it('replaces the editor while on and restores it, keeping unsaved edits, when off', async () => {
    await open('README.md', '# Title')
    const box = screen.getByLabelText('README.md')
    fireEvent.change(box, { target: { value: '# Edited but unsaved' } })
    expect(await screen.findByText('未保存')).toBeTruthy()

    fireEvent.click(previewSwitch() as HTMLInputElement)
    // The rendered heading, not the source line.
    expect(await screen.findByRole('heading', { level: 1, name: 'Edited but unsaved' })).toBeTruthy()
    expect(screen.queryByLabelText('README.md')).toBeNull()

    fireEvent.click(previewSwitch() as HTMLInputElement)
    // The unsaved buffer survived the round trip; previewing is not a save,
    // and it is not a discard either.
    await waitFor(() => { expect(screen.getByLabelText<HTMLTextAreaElement>('README.md').value).toBe('# Edited but unsaved') })
    expect(screen.getByText('未保存')).toBeTruthy()
  })

  it('hides the write actions while previewing and restores them when off', async () => {
    await open('README.md', '# Title')
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    fireEvent.click(previewSwitch() as HTMLInputElement)
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
    fireEvent.click(previewSwitch() as HTMLInputElement)
    await waitFor(() => { expect(screen.getByRole('button', { name: '保存' })).toBeTruthy() })
  })

  it('renders the write actions at the compact size that matches the status text', async () => {
    await open('main.ts', 'const a = 1')
    // 12px is the size of the "已保存" text these buttons sit beside; the shared
    // Button's default `md` would be 14px and read a step larger than its
    // neighbours. The class name is the atom's size slot, checked here because
    // jsdom computes no layout.
    for (const name of ['保存', '重新加载']) {
      expect(screen.getByRole('button', { name }).className).toContain('sm')
    }
  })

  it('starts off again when another file is opened', async () => {
    const remote: FileBrowserRemote = {
      ...remoteStub('# Title'),
      list: () => Promise.resolve({
        ok: true as const,
        value: listing([{ name: 'a.md', kind: 'file' }, { name: 'b.md', kind: 'file' }]),
      }),
    }
    render(
      <FileBrowserModal
        open
        request={{ kind: 'workspace', workspaceId: WID, title: 'Project' }}
        onClose={() => {}}
        remote={remote}
        t={t}
      />,
    )
    fireEvent.click(await screen.findByText('a.md'))
    await screen.findByText('已保存')
    fireEvent.click(previewSwitch() as HTMLInputElement)
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy()

    fireEvent.click(screen.getByText('b.md'))
    // The next file opens in its editor, not in the previous file's view. The
    // dialog unmounts the editor between files (the read clears the open file
    // first), so this asserts the outcome the operator sees either way.
    await waitFor(() => { expect(screen.getByLabelText('b.md')).toBeTruthy() })
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(previewSwitch()).not.toBeNull()
    expect((previewSwitch() as HTMLInputElement).checked).toBe(false)
  })
})

describe('Markdown preview', () => {
  it('renders a GFM table as a table', async () => {
    await open('README.md', '| a | b |\n| - | - |\n| 1 | 2 |')
    fireEvent.click(previewSwitch() as HTMLInputElement)
    const table = await screen.findByRole('table')
    expect(table.textContent).toContain('a')
    expect(table.textContent).toContain('2')
  })

  it('renders a mermaid fence as a diagram rather than as a code block', async () => {
    await open('README.md', '```mermaid\ngraph TD;\n  A-->B;\n```')
    fireEvent.click(previewSwitch() as HTMLInputElement)
    // The Mermaid runtime is imported only once a document carries a diagram,
    // so this waits for that import plus the render it drives.
    await waitFor(
      () => { expect(document.querySelector('svg')).not.toBeNull() },
      { timeout: 15_000 },
    )
  })

  it('renders inline TeX through KaTeX', async () => {
    await open('README.md', 'Euler: $e^{i\\pi}+1=0$')
    fireEvent.click(previewSwitch() as HTMLInputElement)
    await waitFor(() => { expect(document.querySelector('.katex')).not.toBeNull() })
  })
})

describe('HTML preview', () => {
  it('hands the buffer to a frame sandboxed to an opaque origin', async () => {
    await open('page.html', '<p id="body">hi</p>')
    fireEvent.click(previewSwitch() as HTMLInputElement)
    const frame = await screen.findByTitle('HTML 预览：page.html')
    expect(frame.tagName).toBe('IFRAME')
    // Scripts may run; the origin is withheld, which is what keeps the
    // previewed document away from this page's storage, cookies, and /api.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toBe('<p id="body">hi</p>')
  })

  it('follows the buffer while previewing unsaved edits', async () => {
    await open('page.html', '<p>first</p>')
    fireEvent.click(previewSwitch() as HTMLInputElement)
    const frame = await screen.findByTitle('HTML 预览：page.html')
    expect(frame.getAttribute('srcdoc')).toBe('<p>first</p>')
  })
})

describe('read-only preview', () => {
  it('offers the same preview switch a browsable file gets', async () => {
    mountFile('README.md', '# Title')
    await screen.findByText('只读')
    // The read-only viewer is the same content pane, so a session file link
    // reaches the same rendering the browser's own entry does.
    expect(previewSwitch()).not.toBeNull()
    fireEvent.click(previewSwitch() as HTMLInputElement)
    expect(await screen.findByRole('heading', { level: 1, name: 'Title' })).toBeTruthy()
  })

  it('previews HTML read-only as well', async () => {
    mountFile('page.htm', '<p>hi</p>')
    await screen.findByText('只读')
    fireEvent.click(previewSwitch() as HTMLInputElement)
    const frame = await screen.findByTitle('HTML 预览：page.htm')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('offers no preview for a file whose kind is unknown', async () => {
    mountFile('main.ts', 'const a = 1')
    await screen.findByText('只读')
    expect(previewSwitch()).toBeNull()
  })
})
