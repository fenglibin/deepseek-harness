// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ImportPreviewFileRequest,
  ImportPreviewRequest,
  SkillAdminEntry,
  SkillEntryId,
  SkillRootView,
  SkillUploadRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import { SkillsSection } from '../src/client/SkillsSection.tsx'
import type { SkillsSectionInjected, SkillsSectionProps } from '../src/client/SkillsSection.tsx'
import { zh, type SkillsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

/** The shipped translation, with parameter substitution applied. */
const t = ((key: SkillsLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    zh[key],
  )) as SkillsSectionProps['t']

/** One entry every field of the wire type carries, living under one root. */
function entry(directory: string, name: string, overrides: Partial<SkillAdminEntry> = {}): SkillAdminEntry {
  const path = `${directory}/${name}.md`
  return {
    entryId: path as SkillEntryId,
    name,
    path,
    directory,
    form: 'flat',
    description: `${name} description`,
    invocation: { modelInvocable: true, userInvocable: true },
    enabled: true,
    shadowed: false,
    ...overrides,
  }
}

const GLOBAL_ROOT = '/home/u/.agents/skills'
const APP_ROOT = '/home/u/.dsh/skills'
const PROJECT_ROOT = '/work/app/.dsh/skills'

/** A deployment holding one entry per scope, plus a shadowed and a disabled one. */
const ROOTS: readonly SkillRootView[] = [
  {
    path: PROJECT_ROOT,
    source: 'project-dsh',
    rank: 100,
    projectRoot: '/work/app',
    writable: true,
    entries: [entry(PROJECT_ROOT, 'project-skill')],
  },
  {
    path: GLOBAL_ROOT,
    source: 'user-agents',
    rank: 500,
    writable: true,
    entries: [
      entry(GLOBAL_ROOT, 'global-skill'),
      entry(GLOBAL_ROOT, 'shadowed-skill', { shadowed: true }),
      entry(GLOBAL_ROOT, 'broken-skill', { description: '', invalid: 'missing YAML frontmatter' }),
    ],
  },
  {
    path: APP_ROOT,
    source: 'user-dsh',
    rank: 400,
    writable: true,
    entries: [
      entry(APP_ROOT, 'app-skill'),
      entry(APP_ROOT, 'parked-skill', { enabled: false }),
    ],
  },
]

/** Assemble the four prop shares a rendered section receives. */
function props(
  overrides: Partial<SkillsSectionInjected> = {},
  workspaces: readonly Record<string, unknown>[] = [],
): SkillsSectionProps {
  return {
    t,
    close: () => {},
    useWorkspaces: (selector: (snapshot: unknown) => unknown) => selector({
      items: workspaces,
      archivedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
    }),
    list: () => Promise.resolve({ roots: ROOTS }),
    remove: () => Promise.resolve(),
    setEnabled: (_entryId, enabled) => Promise.resolve(entry(APP_ROOT, 'toggled', { enabled })),
    listFiles: () => Promise.resolve({
      entryId: `${GLOBAL_ROOT}/global-skill.md` as SkillEntryId,
      directory: GLOBAL_ROOT,
      files: [{ path: 'global-skill.md', bytes: 12 }],
      truncated: false,
    }),
    readFile: () => Promise.resolve({
      entryId: `${GLOBAL_ROOT}/global-skill.md` as SkillEntryId,
      path: 'global-skill.md',
      text: '---\nname: global-skill\n---\n',
      editable: true,
    }),
    writeFile: () => Promise.resolve(),
    previewImport: () => Promise.resolve(PREVIEW as never),
    previewUpload: () => Promise.resolve(PREVIEW as never),
    readPreviewFile: () => Promise.resolve({
      path: 'SKILL.md',
      text: '---\nname: imported\ndescription: From elsewhere\n---\n',
    }),
    commitImport: () => Promise.resolve(),
    ...overrides,
  } as SkillsSectionProps
}

/** The preview the import arms hand back. */
const PREVIEW = {
  previewId: 'preview-1',
  origin: 'github:owner/repo',
  rootPath: GLOBAL_ROOT,
  targetPath: `${GLOBAL_ROOT}/imported`,
  name: 'imported',
  description: 'From elsewhere',
  content: 'Do the imported thing.',
  files: [
    { path: 'SKILL.md', bytes: 64 },
    { path: 'scripts/run.sh', bytes: 8 },
  ],
  totalBytes: 72,
  replaces: false,
}

describe('SkillsSection scopes', () => {
  it('opens on the global scope and shows only that scope\'s entries', async () => {
    render(<SkillsSection {...props()} />)

    await screen.findByText('global-skill description')
    expect(screen.getByText('shadowed-skill description')).toBeDefined()
    // An entry discovery cannot load carries no description, so the row is
    // identified by the name it falls back to.
    expect(screen.getByText('broken-skill')).toBeDefined()
    expect(screen.queryByText('app-skill description')).toBeNull()
    expect(screen.queryByText('project-skill description')).toBeNull()
  })

  it('switches panes without another Host read', async () => {
    const list = vi.fn(() => Promise.resolve({ roots: ROOTS }))
    render(<SkillsSection {...props({ list })} />)
    await screen.findByText('global-skill description')
    expect(list).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('tab', { name: zh.scopeApp }))
    expect(await screen.findByText('app-skill description')).toBeDefined()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('keeps a disabled entry in the pane beside the enabled ones', async () => {
    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('tab', { name: zh.scopeApp }))
    expect(await screen.findByText('parked-skill description')).toBeDefined()
    // A disabled entry is the only place its own switch can turn it back on.
    expect(screen.getByLabelText(zh.enable)).toBeDefined()
  })

  it('asks for a workspace before listing project skills', async () => {
    render(<SkillsSection {...props({}, [{ workspaceId: 'w1', path: '/work/app', title: 'app' }])} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('tab', { name: zh.scopeWorkspace }))
    expect(await screen.findByText(zh.workspaceEmpty)).toBeDefined()
    expect(screen.getByRole('option', { name: 'app' })).toBeDefined()
  })

  it('reads the project roots once a workspace is chosen', async () => {
    const list = vi.fn(() => Promise.resolve({ roots: ROOTS }))
    render(<SkillsSection {...props({ list }, [{ workspaceId: 'w1', path: '/work/app', title: 'app' }])} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('tab', { name: zh.scopeWorkspace }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/work/app' } })

    await waitFor(() => { expect(list).toHaveBeenCalledWith('/work/app') })
    expect(await screen.findByText('project-skill description')).toBeDefined()
  })

  it('reports an empty scope', async () => {
    const list = () => Promise.resolve({
      roots: [{ path: GLOBAL_ROOT, source: 'user-agents', rank: 500, writable: true, entries: [] }],
    })
    render(<SkillsSection {...props({ list })} />)
    expect(await screen.findByText(zh.empty)).toBeDefined()
  })

  it('reports a failed read and retries it', async () => {
    const list = vi.fn(() => Promise.reject(new Error('offline')))
    render(<SkillsSection {...props({ list })} />)
    expect(await screen.findByText(zh.error)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
  })
})

describe('SkillsSection list', () => {
  it('keeps a disabled row wearing the same frame as an enabled one', async () => {
    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('tab', { name: zh.scopeApp }))
    const parked = (await screen.findByText('parked-skill')).closest('li') as HTMLElement
    const live = screen.getByText('app-skill').closest('li') as HTMLElement

    // The parked row augments the shared frame instead of replacing it, so the
    // two rows still share the class that draws the border and padding.
    expect([...parked.classList].filter(name => live.classList.contains(name)).length).toBeGreaterThan(0)
    expect(parked.classList.length).toBeGreaterThan(live.classList.length)
  })

  it('repeats a skill description in a hover bubble', async () => {
    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    fireEvent.mouseEnter(screen.getByText('global-skill description'))
    expect(await screen.findByRole('tooltip')).toBeDefined()
  })

  it('marks shadowed and unloadable entries', async () => {
    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    expect(screen.getByText(zh.entryShadowed)).toBeDefined()
    expect(screen.getByText(zh.entryInvalid)).toBeDefined()
  })

  it('offers no writes on a read-only root', async () => {
    const list = () => Promise.resolve({
      roots: [{
        path: '/app/bundled-skills',
        source: 'user-agents',
        rank: 600,
        writable: false,
        readOnlyReason: 'bundled skill root ships with the deployment',
        entries: [entry('/app/bundled-skills', 'packaged')],
      }],
    })
    render(<SkillsSection {...props({ list })} />)
    await screen.findByText('packaged description')

    expect(screen.queryByRole('button', { name: zh.edit })).toBeNull()
    expect(screen.queryByRole('button', { name: zh.remove })).toBeNull()
    // The switch still states the entry's state; it just cannot be moved.
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(zh.readOnlyRoot)).toBeDefined()
  })

  it('toggles an entry through the Host and reloads the snapshot', async () => {
    const setEnabled = vi.fn(() => Promise.resolve(entry(GLOBAL_ROOT, 'global-skill', { enabled: false })))
    const list = vi.fn(() => Promise.resolve({ roots: ROOTS }))
    render(<SkillsSection {...props({ setEnabled, list })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getAllByLabelText(zh.disable)[0] as HTMLElement)
    await waitFor(() => {
      expect(setEnabled).toHaveBeenCalledWith(`${GLOBAL_ROOT}/global-skill.md`, false, undefined)
    })
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
  })

  it('reports a refused toggle', async () => {
    const setEnabled = vi.fn(() => Promise.reject(new Error('skill-admin/entry-exists')))
    render(<SkillsSection {...props({ setEnabled })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getAllByLabelText(zh.disable)[0] as HTMLElement)
    expect(await screen.findByRole('alert')).toBeDefined()
  })

  it('confirms before deleting and deletes only on confirmation', async () => {
    const remove = vi.fn(() => Promise.resolve())
    render(<SkillsSection {...props({ remove })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getAllByRole('button', { name: zh.remove })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(`${GLOBAL_ROOT}/global-skill.md`)
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: zh.removeConfirm }))
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith(`${GLOBAL_ROOT}/global-skill.md`, undefined)
    })
  })

  it('leaves the entry alone when the deletion is cancelled', async () => {
    const remove = vi.fn(() => Promise.resolve())
    render(<SkillsSection {...props({ remove })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getAllByRole('button', { name: zh.remove })[0] as HTMLElement)
    await screen.findByRole('dialog')
    // The dialog carries two controls with this label: its own close button and
    // the footer's cancel action. Either leaves the entry untouched.
    fireEvent.click(screen.getAllByRole('button', { name: zh.removeCancel })[0] as HTMLElement)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('SkillsSection editor dialog', () => {
  it('lists the entry files and opens the entry point', async () => {
    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getAllByRole('button', { name: zh.edit })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(zh.editTitle.replace('{name}', 'global-skill'))
    // The file tree and the editor path both name the file the Host read.
    expect(await screen.findAllByText('global-skill.md')).toHaveLength(2)
  })

  it('saves an edited file through the Host', async () => {
    const writeFile = vi.fn(() => Promise.resolve())
    render(<SkillsSection {...props({ writeFile })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getAllByRole('button', { name: zh.edit })[0] as HTMLElement)
    const editor = await screen.findByRole('textbox')
    fireEvent.change(editor, { target: { value: '---\nname: global-skill\n---\nChanged.\n' } })

    fireEvent.click(screen.getByRole('button', { name: zh.editorSave }))
    await waitFor(() => {
      expect(writeFile).toHaveBeenCalledWith({
        entryId: `${GLOBAL_ROOT}/global-skill.md`,
        path: 'global-skill.md',
        text: '---\nname: global-skill\n---\nChanged.\n',
      })
    })
  })

  it('reports a file it cannot edit', async () => {
    const readFile = () => Promise.resolve({
      entryId: `${GLOBAL_ROOT}/global-skill.md` as SkillEntryId,
      path: 'global-skill.md',
      text: '',
      editable: false,
      readOnlyReason: 'binary' as const,
    })
    render(<SkillsSection {...props({ readFile })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getAllByRole('button', { name: zh.edit })[0] as HTMLElement)
    expect(await screen.findByText(zh.editorBinary)).toBeDefined()
  })
})

describe('SkillsSection import dialog', () => {
  it('opens on the upload arm', async () => {
    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    expect(screen.getByRole('tab', { name: zh.importTabUpload }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText(zh.importFile)).toBeDefined()
  })

  it('previews a URL before writing it', async () => {
    const previewImport = vi.fn((_request: ImportPreviewRequest) => Promise.resolve(PREVIEW as never))
    render(<SkillsSection {...props({ previewImport })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    fireEvent.click(screen.getByRole('tab', { name: zh.importTabUrl }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: zh.importPreview }))

    await waitFor(() => {
      expect(previewImport).toHaveBeenCalledWith({ source: 'owner/repo', rootPath: GLOBAL_ROOT })
    })
    expect(await screen.findByText('run.sh')).toBeDefined()
  })

  it('offers only the current scope\'s roots as import targets', async () => {
    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    const target = screen.getByRole('combobox') as HTMLSelectElement
    expect(target.value).toBe(GLOBAL_ROOT)
    // The app pane's root is not offered: an import landing there would be
    // absent from the very table the reader is looking at.
    expect(within(target).queryByRole('option', { name: APP_ROOT })).toBeNull()
  })

  it('sends an uploaded archive to the upload arm', async () => {
    const previewUpload = vi.fn((_request: SkillUploadRequest) => Promise.resolve(PREVIEW as never))
    render(<SkillsSection {...props({ previewUpload })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    fireEvent.click(screen.getByRole('tab', { name: zh.importTabUpload }))
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'skill.zip')
    fireEvent.change(screen.getByLabelText(zh.importFile), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: zh.importPreview }))

    await waitFor(() => { expect(previewUpload).toHaveBeenCalled() })
    const request = previewUpload.mock.calls[0]![0]
    expect(request.fileName).toBe('skill.zip')
    expect(request.data).toBe('UEsDBA==')
  })

  it('inspects a staged preview in its own read-only dialog', async () => {
    const readPreviewFile = vi.fn((request: ImportPreviewFileRequest) => Promise.resolve(
      request.path === 'scripts/run.sh'
        ? { path: 'scripts/run.sh', text: 'echo hi\n' }
        : { path: 'SKILL.md', text: '---\nname: imported\n---\n' },
    ))
    render(<SkillsSection {...props({ readPreviewFile })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'skill.zip')
    fireEvent.change(screen.getByLabelText(zh.importFile), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: zh.importPreview }))

    // The entry point opens first and the tree lists every member beside it, so
    // the reader approves files rather than a list of names.
    await waitFor(() => {
      expect(readPreviewFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'SKILL.md' }))
    })
    const shown = await screen.findByDisplayValue(/name: imported/)
    // Previewing means looking: the dialog offers no way to change what a
    // commit would write.
    expect((shown as HTMLTextAreaElement).readOnly).toBe(true)
    expect(screen.getByText('run.sh')).toBeDefined()

    fireEvent.click(screen.getByText('run.sh'))
    expect(await screen.findByDisplayValue(/echo hi/)).toBeDefined()
  })

  it('keeps the import form filled while a preview is open', async () => {
    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    fireEvent.click(screen.getByRole('tab', { name: zh.importTabUrl }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: zh.importPreview }))
    await screen.findByText('run.sh')

    // The preview stacks over the form rather than replacing it, so closing it
    // returns the reader to what they had already typed.
    fireEvent.click(screen.getByRole('button', { name: zh.importPreviewBack }))
    expect(screen.queryByText('run.sh')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('owner/repo')
  })

  it('closes only the topmost dialog on Escape', async () => {
    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    fireEvent.click(screen.getByRole('tab', { name: zh.importTabUrl }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: zh.importPreview }))
    await screen.findByText('run.sh')

    // Both modals listen on the document, so a single Escape reaches both
    // handlers; the form underneath must survive it and keep what it held.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('run.sh')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('owner/repo')

    // With the preview gone the form is the top dialog again and closes.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tab', { name: zh.importTabUrl })).toBeNull()
  })

  it('resolves the pending payload once when the preview is reopened', async () => {    const previewImport = vi.fn((_request: ImportPreviewRequest) => Promise.resolve(PREVIEW as never))
    render(<SkillsSection {...props({ previewImport })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    fireEvent.click(screen.getByRole('tab', { name: zh.importTabUrl }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: zh.importPreview }))
    await screen.findByText('run.sh')
    fireEvent.click(screen.getByRole('button', { name: zh.importPreviewBack }))
    fireEvent.click(screen.getByRole('button', { name: zh.importPreview }))
    await screen.findByText('run.sh')

    // Staging a second copy of the same bytes would only burn one of the
    // bounded preview slots.
    expect(previewImport).toHaveBeenCalledTimes(1)
  })

  it('drops a preview when the reader switches arms', async () => {    render(<SkillsSection {...props()} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    fireEvent.click(screen.getByRole('tab', { name: zh.importTabUrl }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: zh.importPreview }))
    await screen.findByText('run.sh')

    fireEvent.click(screen.getByRole('button', { name: zh.importPreviewBack }))
    fireEvent.click(screen.getByRole('tab', { name: zh.importTabUpload }))
    expect(screen.queryByText('run.sh')).toBeNull()
  })

  it('saves the source straight into the library without a preview step', async () => {
    const commitImport = vi.fn(() => Promise.resolve())
    render(<SkillsSection {...props({ commitImport })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    fireEvent.click(screen.getByRole('tab', { name: zh.importTabUrl }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: zh.importSave }))

    await waitFor(() => { expect(commitImport).toHaveBeenCalledWith('preview-1') })
    // Saving is the whole gesture: no preview dialog opens on the way.
    expect(screen.queryByText('run.sh')).toBeNull()
  })

  it('refuses to save over an existing entry without calling commit', async () => {
    const commitImport = vi.fn(() => Promise.resolve())
    const previewImport = vi.fn((_request: ImportPreviewRequest) => Promise.resolve(
      { ...PREVIEW, replaces: true } as never,
    ))
    render(<SkillsSection {...props({ commitImport, previewImport })} />)
    await screen.findByText('global-skill description')

    fireEvent.click(screen.getByRole('button', { name: zh.importSkill }))
    fireEvent.click(screen.getByRole('tab', { name: zh.importTabUrl }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: zh.importSave }))

    expect(await screen.findByText(zh.importReplaces)).toBeDefined()
    expect(commitImport).not.toHaveBeenCalled()
  })
})
