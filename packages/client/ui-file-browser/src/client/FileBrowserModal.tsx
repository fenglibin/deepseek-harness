/**
 * The workspace file browser dialog: the tree column, the search or content
 * pane, and every Remote call the surfaces drive.
 *
 * All server state lives here rather than in the two presentational children:
 * the tree renders levels it is handed, and the editor renders a buffer it is
 * handed. That keeps the mutation ordering in one place — a create refreshes
 * the affected directory, a rename refreshes the source and target parents, a
 * delete clears the selection when it removed the open file.
 *
 * The pane shows one of five things, decided by what the file turned out to be:
 * the editor for text, an `<img>` for a supported image kind, or a stated
 * refusal for binary, oversize, and unreadable targets. Only the text arm is
 * writable, which is what "text is editable, images are viewable" reduces to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutline16, IconPlusOutline16, IconProjectAddOutline16, Input, Modal, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { FileBrowserEntry } from '@deepseek-ai/dsh-api-file-browser/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { isFileRequest, type FileBrowserRequest } from './request.ts'
import { CodeEditor } from './CodeEditor.tsx'
import { FileTree, type TreeLevel } from './FileTree.tsx'
import { useResizeHandles } from './use-resize.ts'
import css from './FileBrowserModal.module.css'

/**
 * The `fileBrowser` Remote namespace this dialog drives. Deriving it from the
 * generated Client assembly keeps the envelope (`RemoteResult`) and every
 * request shape owned by the wire, so this package re-declares neither.
 */
export type FileBrowserRemote = ClientRemote['fileBrowser']

/**
 * What one `read` answered. Narrowed from the generated namespace's success
 * arm, so the pane's switch over the four arms stays exhaustive against the
 * Host union rather than a restatement of it.
 */
export type FileBrowserContentValue =
  Extract<Awaited<ReturnType<FileBrowserRemote['read']>>, { ok: true }>['value']

/** What the dialog was asked to show. */
export interface FileBrowserModalProps {
  /** Whether the dialog is open; a closed dialog renders nothing. */
  open: boolean
  /** The open request: browse a Workspace, or view one file read-only. */
  request?: FileBrowserRequest | undefined
  /** Close without changing anything. */
  onClose: () => void
  /** The fileBrowser Remote namespace. */
  remote: FileBrowserRemote
  /**
   * Open one path through the Host desktop opener. Omitted — the remote
   * deployment case — the viewer simply offers no such action. Resolves to the
   * refusal message, or undefined when the Host accepted it.
   */
  openNative?: ((path: string) => Promise<string | undefined>) | undefined
  /** Localized chrome. */
  t: TranslateNS<'fileBrowser'>
}

/** One open file's loaded state. */
interface OpenFile {
  path: string
  content: FileBrowserContentValue
}

/**
 * Human-readable byte size for the degrade notices. The unit templates come
 * from the dictionary rather than a literal, so no display string is
 * hard-coded in a component.
 * @param bytes - the size to render.
 * @param t - the dialog's locale seat.
 * @returns the localized size text.
 */
function formatBytes(bytes: number, t: TranslateNS<'fileBrowser'>): string {
  if (bytes < 1024) return t('size.bytes', { n: String(bytes) })
  if (bytes < 1024 * 1024) return t('size.kilobytes', { n: (bytes / 1024).toFixed(1) })
  return t('size.megabytes', { n: (bytes / (1024 * 1024)).toFixed(1) })
}

/** The parent directory of a workspace-relative path (`''` at the root). */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/**
 * Render the file browser dialog.
 * @param props - see {@link FileBrowserModalProps}.
 * @returns the dialog element.
 */
export function FileBrowserModal({ open, request, onClose, remote, openNative, t }: FileBrowserModalProps) {
  const workspaceId = request?.kind === 'workspace' || request?.kind === 'file' ? request.workspaceId : undefined
  // A file request opens that file directly and read-only; a workspace request
  // starts at the tree. Deriving both from the one discriminated value keeps
  // "browse read-only" unrepresentable rather than merely unhandled.
  const fileView = isFileRequest(request)
  const directPath = request?.kind === 'file' ? request.path : undefined
  const readOnly = request?.kind === 'file'
  // The dialog heading names the Workspace being browsed, when there is one.
  const title = request === undefined || request.kind === 'unavailable' ? undefined : request.title
  const { onFramePointerDown, onSplitPointerDown } = useResizeHandles()
  const [levels, setLevels] = useState<ReadonlyMap<string, TreeLevel>>(new Map())
  // The root level's own state gates the create verbs: creating into a level
  // that failed to load would just fail again.
  const rootLevel = levels.get('')
  const rootReady = rootLevel !== undefined && !rootLevel.loading && rootLevel.error === undefined
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | undefined>(undefined)
  // The create destination, tracked apart from the open file: selecting a
  // directory means "create in here", and the root is the initial destination.
  const [selectedDirectory, setSelectedDirectory] = useState<string>('')
  const [file, setFile] = useState<OpenFile | undefined>(undefined)
  const [buffer, setBuffer] = useState('')
  const [version, setVersion] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [readError, setReadError] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [conflict, setConflict] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  // The desktop opener's refusal. Held here rather than in the request so a
  // failed hand-off never discards the file already on screen.
  const [openLocalError, setOpenLocalError] = useState<string | undefined>(undefined)

  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'ready'; matches: readonly { path: string; kind: 'file' | 'directory' }[]; truncated: boolean } | { status: 'error'; message: string }
  >({ status: 'idle' })

  const [createTarget, setCreateTarget] = useState<{ directory: string; kind: 'file' | 'directory' } | undefined>(undefined)
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [renameTarget, setRenameTarget] = useState<FileBrowserEntry | undefined>(undefined)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<FileBrowserEntry | undefined>(undefined)
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false)

  // A superseded listing must not overwrite a newer one; each request carries
  // its own sequence number and only the newest may publish.
  const listSequence = useRef(0)

  const patchLevel = useCallback((path: string, level: TreeLevel): void => {
    setLevels(current => new Map(current).set(path, level))
  }, [])

  /** Fetch one directory level and publish it under its path. */
  const loadLevel = useCallback((path: string): void => {
    if (workspaceId === undefined) return
    const sequence = listSequence.current + 1
    listSequence.current = sequence
    patchLevel(path, { entries: levels.get(path)?.entries ?? [], truncated: false, loading: true })
    void remote.list({ workspaceId, path, showHidden }).then(
      (result) => {
        if (listSequence.current !== sequence) return
        if (!result.ok) {
          patchLevel(path, { entries: [], truncated: false, loading: false, error: t('tree.failed') })
          return
        }
        patchLevel(path, {
          entries: result.value.entries,
          truncated: result.value.truncated,
          loading: false,
        })
      },
      () => {
        if (listSequence.current !== sequence) return
        patchLevel(path, { entries: [], truncated: false, loading: false, error: t('tree.failed') })
      },
    )
  }, [levels, patchLevel, remote, showHidden, t, workspaceId])

  // Opening the dialog (or switching Workspace, or flipping the hidden-files
  // choice) restarts from the root: the loaded levels describe a different
  // listing than the one being asked for. A file view has no tree, so it skips
  // the listing entirely.
  useEffect(() => {
    if (!open || workspaceId === undefined) return
    setLevels(new Map())
    setExpanded(new Set())
    setSelected(undefined)
    setSelectedDirectory('')
    setFile(undefined)
    setQuery('')
    setSearchState({ status: 'idle' })
    setOpenLocalError(undefined)
    listSequence.current += 1
    if (fileView) return
    const sequence = listSequence.current
    patchLevel('', { entries: [], truncated: false, loading: true })
    void remote.list({ workspaceId, showHidden }).then(
      (result) => {
        if (listSequence.current !== sequence) return
        if (!result.ok) {
          patchLevel('', { entries: [], truncated: false, loading: false, error: t('tree.failed') })
          return
        }
        patchLevel('', { entries: result.value.entries, truncated: result.value.truncated, loading: false })
      },
      () => {
        if (listSequence.current !== sequence) return
        patchLevel('', { entries: [], truncated: false, loading: false, error: t('tree.failed') })
      },
    )
  }, [open, workspaceId, showHidden, patchLevel, remote, t, fileView])

  /** Hand the viewed file to the desktop opener and report any refusal. */
  const openLocal = useCallback((path: string): void => {
    if (openNative === undefined) return
    setOpenLocalError(undefined)
    void openNative(path).then((message) => { setOpenLocalError(message) })
  }, [openNative])

  /** Read one file into the content pane. */
  const openFile = useCallback((path: string): void => {
    if (workspaceId === undefined) return
    setSelected(path)
    setReadError(undefined)
    setSaveError(undefined)
    setConflict(false)
    setFile(undefined)
    void remote.read({ workspaceId, path }).then(
      (result) => {
        if (!result.ok) {
          setReadError(t('content.failed'))
          return
        }
        setFile({ path, content: result.value })
        if (result.value.kind === 'text') {
          setBuffer(result.value.text)
          setVersion(result.value.version)
        }
      },
      () => { setReadError(t('content.failed')) },
    )
  }, [remote, t, workspaceId])

  // A file request opens that file as soon as the dialog is showing. Declared
  // after the reset effect above so the two run in that order within one commit:
  // the reset clears the pane, then this fills it.
  useEffect(() => {
    if (!open || directPath === undefined) return
    openFile(directPath)
  }, [directPath, open, openFile])

  /** Write the buffer back, guarded by the version the file was read at. */
  const save = useCallback(async (force: boolean): Promise<void> => {
    if (workspaceId === undefined || file === undefined || file.content.kind !== 'text') return
    setSaving(true)
    setSaveError(undefined)
    const result = await remote.write({
      workspaceId,
      path: file.path,
      content: buffer,
      // A forced overwrite omits the guard, which is exactly what the Host
      // reads as "write unconditionally".
      ...(force || version === undefined ? {} : { version }),
    }).catch(() => undefined)
    setSaving(false)
    if (result === undefined) {
      setSaveError(t('content.saveFailed'))
      return
    }
    if (!result.ok) {
      // A version mismatch is not a generic failure: it means someone else
      // wrote the file, which the operator resolves deliberately.
      if (result.error.code === 'file-browser/stale') setConflict(true)
      else setSaveError(t('content.saveFailed'))
      return
    }
    setConflict(false)
    setVersion(result.value.version)
    setFile({ path: file.path, content: { kind: 'text', text: buffer, version: result.value.version, size: buffer.length } })
  }, [buffer, file, remote, t, version, workspaceId])

  /** Open the create dialog for one destination directory and entry kind. */
  const openCreate = useCallback((directory: string, kind: 'file' | 'directory'): void => {
    setCreateTarget({ directory, kind })
    setCreateName('')
    setCreateError(undefined)
  }, [])

  const toggle = useCallback((path: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        // First open fetches the level; a reopen reuses the cached children.
        if (!levels.has(path)) loadLevel(path)
      }
      return next
    })
  }, [levels, loadLevel])

  // Debounced name search. A blank query returns to the tree, and a superseded
  // request is dropped by the same sequence discipline the listings use.
  const searchSequence = useRef(0)
  useEffect(() => {
    if (!open || workspaceId === undefined) return
    const trimmed = query.trim()
    if (trimmed === '') {
      searchSequence.current += 1
      setSearchState({ status: 'idle' })
      return
    }
    setSearchState({ status: 'loading' })
    const sequence = searchSequence.current + 1
    searchSequence.current = sequence
    const timer = setTimeout(() => {
      void remote.search({ workspaceId, query: trimmed }).then(
        (result) => {
          if (searchSequence.current !== sequence) return
          if (!result.ok) {
            setSearchState({ status: 'error', message: t('search.failed') })
            return
          }
          setSearchState({ status: 'ready', matches: result.value.matches, truncated: result.value.truncated })
        },
        () => {
          if (searchSequence.current !== sequence) return
          setSearchState({ status: 'error', message: t('search.failed') })
        },
      )
    }, 250)
    return () => { clearTimeout(timer) }
  }, [open, query, remote, t, workspaceId])

  /** Jump to a search hit: reveal its ancestors and open it. */
  const revealMatch = useCallback((path: string, kind: 'file' | 'directory'): void => {
    const segments = path.split('/')
    const ancestors: string[] = []
    for (let index = 1; index < segments.length; index += 1) {
      ancestors.push(segments.slice(0, index).join('/'))
    }
    for (const ancestor of ancestors) {
      if (!levels.has(ancestor)) loadLevel(ancestor)
    }
    setExpanded(current => new Set([...current, ...ancestors]))
    if (kind === 'file') openFile(path)
    else setSelected(path)
  }, [levels, loadLevel, openFile])

  const submitCreate = useCallback(async (): Promise<void> => {
    if (workspaceId === undefined || createTarget === undefined) return
    setCreateError(undefined)
    const result = await remote.create({
      workspaceId,
      ...(createTarget.directory === '' ? {} : { directory: createTarget.directory }),
      name: createName,
      kind: createTarget.kind,
    }).catch(() => undefined)
    if (result === undefined) {
      setCreateError(t('content.saveFailed'))
      return
    }
    if (!result.ok) {
      setCreateError(result.error.message)
      return
    }
    const directory = createTarget.directory
    setCreateTarget(undefined)
    setCreateName('')
    if (directory === '' || expanded.has(directory)) loadLevel(directory)
  }, [createName, createTarget, expanded, loadLevel, remote, t, workspaceId])

  const submitRename = useCallback(async (): Promise<void> => {
    if (workspaceId === undefined || renameTarget === undefined) return
    setRenameError(undefined)
    const result = await remote.rename({ workspaceId, path: renameTarget.path, name: renameName })
      .catch(() => undefined)
    if (result === undefined) {
      setRenameError(t('content.saveFailed'))
      return
    }
    if (!result.ok) {
      setRenameError(result.error.message)
      return
    }
    const source = renameTarget.path
    setRenameTarget(undefined)
    setRenameName('')
    loadLevel(parentOf(source))
    if (selected === source) setSelected(result.value.path)
  }, [loadLevel, remote, renameName, renameTarget, selected, t, workspaceId])

  const submitDelete = useCallback(async (): Promise<void> => {
    if (workspaceId === undefined || deleteTarget === undefined) return
    const target = deleteTarget
    setDeleteTarget(undefined)
    setDeleteAcknowledged(false)
    const result = await remote.delete({ workspaceId, path: target.path }).catch(() => undefined)
    if (result === undefined || !result.ok) {
      setReadError(t('content.failed'))
      return
    }
    // Deleting the open file leaves nothing to show; deleting a directory also
    // invalidates every level loaded beneath it.
    if (selected === target.path || (selected?.startsWith(`${target.path}/`) ?? false)) {
      setSelected(undefined)
      setFile(undefined)
      setReadError(undefined)
    }
    setLevels((current) => {
      const next = new Map(current)
      for (const key of next.keys()) {
        if (key === target.path || key.startsWith(`${target.path}/`)) next.delete(key)
      }
      return next
    })
    loadLevel(parentOf(target.path))
  }, [deleteTarget, loadLevel, remote, selected, t, workspaceId])

  const editorLabels = useMemo(() => ({
    save: t('content.save'),
    saving: t('content.saving'),
    saved: t('content.saved'),
    unsaved: t('content.unsaved'),
    reload: t('content.reload'),
    saveFailed: t('content.saveFailed'),
    conflict: t('content.conflict'),
    overwrite: t('content.overwrite'),
    readonly: t('content.readonly'),
    loading: t('tree.loading'),
    preview: t('content.preview'),
    previewFrame: t('content.previewFrame', { name: file?.path ?? '' }),
    copy: t('content.copy'),
    copied: t('content.copied'),
    footnotes: t('content.footnotes'),
    diagramError: t('content.diagramError'),
  }), [file?.path, t])

  /** The content pane's body, decided by the loaded file's arm. */
  const contentPane = (): React.ReactNode => {
    // A request that could not be resolved states why instead of showing a
    // pane that will never fill.
    if (request?.kind === 'unavailable') {
      return (
        <div className={css.notice} role="alert">
          <span>{t('content.noWorkspace')}</span>
          <span className={css.path}>{request.path}</span>
        </div>
      )
    }
    if (readError !== undefined) return <div className={css.notice} role="alert">{readError}</div>
    if (file === undefined) {
      return <div className={css.notice}>{selected === undefined ? t('content.none') : t('tree.loading')}</div>
    }
    switch (file.content.kind) {
      case 'text':
        return (
          <CodeEditor
            path={file.path}
            savedText={file.content.text}
            text={buffer}
            onChange={setBuffer}
            onSave={() => save(false)}
            onReload={() => { openFile(file.path) }}
            saving={saving}
            conflict={conflict}
            onOverwrite={() => { void save(true) }}
            loading={false}
            readOnly={readOnly}
            error={readOnly ? readError : saveError}
            labels={editorLabels}
          />
        )
      case 'image':
        return (
          <div className={css.imagePane}>
            <img
              className={css.image}
              src={file.content.url}
              alt={t('content.image.aria', { name: file.path })}
            />
          </div>
        )
      case 'binary':
        return (
          <div className={css.notice}>
            <span>{t('content.binary')}</span>
            {openNative !== undefined && (
              <button type="button" className={css.linkButton} onClick={() => { openLocal(file.path) }}>
                {t('content.openLocal')}
              </button>
            )}
          </div>
        )
      case 'too-large':
        return (
          <div className={css.notice}>
            <span>
              {t('content.tooLarge', {
                size: formatBytes(file.content.size, t),
                limit: formatBytes(file.content.limit, t),
              })}
            </span>
            {openNative !== undefined && (
              <button type="button" className={css.linkButton} onClick={() => { openLocal(file.path) }}>
                {t('content.openLocal')}
              </button>
            )}
          </div>
        )
      /* v8 ignore next -- closed union backstop; the Host answers only the four arms above. */
      default:
        return <div className={css.notice}>{t('content.binary')}</div>
    }
  }

  /** The browsing layout: the tree column beside the content pane. */
  const browseLayout = (
    <div className={css.layout}>
      <div className={css.side}>
        <div className={css.treeHost}>
          {searchState.status === 'idle'
            ? (
              <FileTree
                levels={levels}
                expanded={expanded}
                onToggle={toggle}
                selected={selected}
                selectedDirectory={selectedDirectory}
                t={t}
                actions={{
                  load: loadLevel,
                  select: openFile,
                  selectDirectory: setSelectedDirectory,
                  rename: (entry) => { setRenameTarget(entry); setRenameName(entry.name); setRenameError(undefined) },
                  remove: (entry) => { setDeleteTarget(entry); setDeleteAcknowledged(false) },
                }}
              />
            )
            : (
              <div className={css.results} role="tree" aria-label={t('search.results.aria')}>
                {searchState.status === 'loading' && <div className={css.notice}>{t('tree.loading')}</div>}
                {searchState.status === 'error' && <div className={css.notice} role="alert">{searchState.message}</div>}
                {searchState.status === 'ready' && searchState.matches.length === 0 && (
                  <div className={css.notice}>{t('search.empty')}</div>
                )}
                {searchState.status === 'ready' && searchState.matches.map(match => (
                  <button
                    key={match.path}
                    type="button"
                    className={css.resultRow}
                    role="treeitem"
                    onClick={() => { revealMatch(match.path, match.kind) }}
                  >
                    {match.path}
                  </button>
                ))}
                {searchState.status === 'ready' && searchState.truncated && (
                  <div className={css.notice}>
                    {t('search.truncated', { n: String(searchState.matches.length) })}
                  </div>
                )}
              </div>
            )}
        </div>
      </div>
      <div
        className={css.resizeHandle}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('split.aria')}
        onPointerDown={onSplitPointerDown}
      />
      <div className={css.content}>{contentPane()}</div>
    </div>
  )

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title === undefined ? t('dialog.title') : `${t('dialog.title')} — ${title}`}
        className={clsx(css.dialog)}
        contentClassName={clsx(css.dialogContent)}
        bodyClassName={clsx(css.dialogBody)}
        // The toolbar row below owns the title and the close control, so the
        // card renders the children alone rather than a second header.
        headless
      >
        {/* One toolbar row owns every control: the title, the name search, the
            hidden-entries toggle, and the two create verbs. Stacking them would
            push the tree down by a row each while saying nothing more. */}
        <div className={css.toolbar}>
          <span className={css.toolbarTitle} title={title}>
            {title === undefined ? t('dialog.title') : `${t('dialog.title')} — ${title}`}
          </span>
          {/* A file view is one file: the search box, the hidden-entries
              toggle, and the create verbs all address the tree, which this
              mode does not show. */}
          {!fileView && (
            <>
              <span className={css.search}>
                <Input
                  value={query}
                  placeholder={t('search.placeholder')}
                  aria-label={t('search.aria')}
                  maxLength={200}
                  onChange={(event) => { setQuery(event.target.value) }}
                />
                {query !== '' && (
                  <button type="button" className={css.linkButton} onClick={() => { setQuery('') }}>
                    {t('search.clear')}
                  </button>
                )}
              </span>
              <label className={css.toggle} title={t('tree.showHidden')}>
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => { setShowHidden(event.target.checked) }}
                />
                <span>{t('tree.showHiddenShort')}</span>
              </label>
            </>
          )}
          {/* The desktop opener is a secondary action here: the content is
              already on screen, so this only offers the editor when the page
              is on the Host itself. It leads the right-hand group so the close
              control keeps the far-right seat in both modes. */}
          <span className={css.toolbarEnd}>
            {/* The create verbs act on the tree, so they exist only while it
                does; they ride this group to keep one right-aligned edge. */}
            {!fileView && (
              <span className={css.toolbarActions}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('file.newFile')}
                  title={t('file.newFile')}
                  disabled={!rootReady}
                  onClick={() => { openCreate(selectedDirectory, 'file') }}
                >
                  <IconPlusOutline16 />
                </button>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('file.newFolder')}
                  title={t('file.newFolder')}
                  disabled={!rootReady}
                  onClick={() => { openCreate(selectedDirectory, 'directory') }}
                >
                  <IconProjectAddOutline16 />
                </button>
              </span>
            )}
            {readOnly && openNative !== undefined && directPath !== undefined && (
              <button type="button" className={css.linkButton} onClick={() => { openLocal(directPath) }}>
                {t('content.openLocal')}
              </button>
            )}
            <button type="button" className={css.iconButton} aria-label={t('dialog.close')} onClick={onClose}>
              <IconCloseOutline16 size={14} />
            </button>
          </span>
        </div>
        {/* The desktop opener's refusal sits directly under the toolbar that
            raised it, so the file on screen stays where it is. */}
        {openLocalError !== undefined && (
          <div className={css.error} role="alert">
            {t('content.openLocalFailed')}: {openLocalError}
          </div>
        )}
        {fileView ? <div className={css.content}>{contentPane()}</div> : browseLayout}
        {!fileView && <div className={css.sizeGrip} aria-hidden="true" onPointerDown={onFramePointerDown} />}
      </Modal>

      <Modal
        open={createTarget !== undefined}
        onClose={() => { setCreateTarget(undefined) }}
        title={createTarget?.kind === 'directory' ? t('file.newFolder') : t('file.newFile')}
        closeLabel={t('dialog.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreateTarget(undefined) }}>{t('file.cancel')}</Button>
            <Button variant="primary" disabled={createName.trim() === ''} onClick={() => { void submitCreate() }}>
              {t('file.create')}
            </Button>
          </>
        )}
      >
        <Input
          value={createName}
          aria-label={t('file.name')}
          placeholder={t('file.untitled')}
          autoFocus
          onChange={(event) => { setCreateName(event.target.value) }}
        />
        {createError !== undefined && <div className={css.notice} role="alert">{createError}</div>}
      </Modal>

      <Modal
        open={renameTarget !== undefined}
        onClose={() => { setRenameTarget(undefined) }}
        title={t('file.rename')}
        closeLabel={t('dialog.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setRenameTarget(undefined) }}>{t('file.cancel')}</Button>
            <Button variant="primary" disabled={renameName.trim() === ''} onClick={() => { void submitRename() }}>
              {t('file.confirm')}
            </Button>
          </>
        )}
      >
        <Input
          value={renameName}
          aria-label={t('file.name')}
          autoFocus
          onChange={(event) => { setRenameName(event.target.value) }}
        />
        {renameError !== undefined && <div className={css.notice} role="alert">{renameError}</div>}
      </Modal>

      <RiskConfirmation
        open={deleteTarget !== undefined}
        title={t('delete.title')}
        description={t('delete.description', { name: deleteTarget?.name ?? '' })}
        acknowledgeLabel={t('delete.acknowledge')}
        cancelLabel={t('file.cancel')}
        closeLabel={t('delete.close')}
        confirmLabel={t('delete.confirm')}
        acknowledged={deleteAcknowledged}
        onAcknowledgedChange={setDeleteAcknowledged}
        onCancel={() => { setDeleteTarget(undefined); setDeleteAcknowledged(false) }}
        onConfirm={() => { void submitDelete() }}
      />
    </>
  )
}
