/**
 * The skill editor dialog: a file tree on the left and a highlighted editor on
 * the right, over one entry's files.
 *
 * The editor writes files verbatim rather than through the frontmatter fields
 * the section used to expose, so what a reader sees in the editor is what the
 * discovery pass will parse. The frontmatter contract is still enforced, on the
 * Host side, at the moment of the write.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SkillAdminEntry,
  SkillFileDocument,
  SkillFileTree as SkillFileListing,
  SkillFileWriteRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillsLocaleKey } from './locales.ts'
import { SkillFileEditor, languageOf } from './SkillFileEditor.tsx'
import { SkillFileTree } from './SkillFileTree.tsx'
import css from './SkillsSection.module.css'

/** Props of {@link SkillEditorDialog}. */
export interface SkillEditorDialogProps {
  /** Entry whose files are edited. */
  readonly entry: SkillAdminEntry
  /** Workspace the entry was resolved under, forwarded to every Host call. */
  readonly projectRoot: string | undefined
  /** Section copy. */
  readonly t: (key: SkillsLocaleKey, params?: Record<string, string>) => string
  /** List the entry's files. */
  readonly listFiles: (entryId: string, projectRoot?: string) => Promise<SkillFileListing>
  /** Read one of the entry's files. */
  readonly readFile: (entryId: string, path: string, projectRoot?: string) => Promise<SkillFileDocument>
  /** Replace one of the entry's files. */
  readonly writeFile: (request: SkillFileWriteRequest) => Promise<void>
  /** Close the dialog. */
  readonly onClose: () => void
  /** Report that a write landed, so the section reloads its snapshot. */
  readonly onSaved: () => void
}

/** What the dialog knows about the entry's file list. */
type TreeState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly tree: SkillFileListing }

/** What the dialog knows about the file it is showing. */
type DocumentState =
  | { readonly status: 'loading'; readonly path: string }
  | { readonly status: 'error'; readonly path: string }
  | { readonly status: 'ready'; readonly document: SkillFileDocument }

/** The skill editor dialog. */
export function SkillEditorDialog(props: SkillEditorDialogProps): ReactNode {
  const { entry, projectRoot, t, listFiles, readFile, writeFile, onClose, onSaved } = props
  const [tree, setTree] = useState<TreeState>({ status: 'loading' })
  const [selected, setSelected] = useState('')
  const [document, setDocument] = useState<DocumentState | null>(null)
  // `null` means the reader has not typed in the file currently open; an empty
  // string is a deliberate edit that clears it, which must stay saveable.
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const entryId = String(entry.entryId)

  const loadTree = useCallback(async () => {
    setTree({ status: 'loading' })
    try {
      const listing = await listFiles(entryId, projectRoot)
      setTree({ status: 'ready', tree: listing })
      // The entry point is what a reader almost always came to edit; the first
      // file is the fallback for a package that does not hold one.
      const entryPoint = listing.files.find(file => file.path.endsWith('SKILL.md'))
      setSelected(entryPoint?.path ?? listing.files[0]?.path ?? '')
    } catch {
      setTree({ status: 'error' })
    }
  }, [entryId, listFiles, projectRoot])

  useEffect(() => { void loadTree() }, [loadTree])

  useEffect(() => {
    if (selected === '') return
    let live = true
    setDocument({ status: 'loading', path: selected })
    setDraft(null)
    void (async () => {
      try {
        const read = await readFile(entryId, selected, projectRoot)
        if (live) setDocument({ status: 'ready', document: read })
      } catch {
        if (live) setDocument({ status: 'error', path: selected })
      }
    })()
    return () => { live = false }
  }, [entryId, readFile, projectRoot, selected])

  const current = document?.status === 'ready' ? document.document : null
  const text = draft ?? current?.text ?? ''
  const dirty = draft !== null && draft !== current?.text
  const language = useMemo(() => languageOf(selected), [selected])

  const save = async (): Promise<void> => {
    if (current === null || draft === null || draft === current.text) return
    setBusy(true)
    setFailure(null)
    try {
      await writeFile({ entryId: entryId as never, path: selected, text: draft, ...projectRoot === undefined ? {} : { projectRoot } })
      setDocument({ status: 'ready', document: { ...current, text: draft } })
      setDraft(null)
      onSaved()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const requestClose = (): void => {
    onClose()
  }

  return (
    <Modal
      open
      onClose={requestClose}
      title={t('editTitle', { name: entry.name })}
      closeLabel={t('editorCancel')}
      className={css.editorDialog ?? ''}
      bodyClassName={css.editorBody ?? ''}
      footer={(
        <div className={css.dialogActions}>
          <span className={css.grow}>
            {failure === null ? null : <span className={css.error}>{failure}</span>}
            {failure === null && dirty ? <span className={css.hint}>{t('editorUnsaved')}</span> : null}
          </span>
          <button className={css.link} type="button" onClick={requestClose}>{t('editorCancel')}</button>
          <button
            className={css.primary}
            type="button"
            disabled={busy || current === null || !current.editable || !dirty}
            onClick={() => { void save() }}
          >
            {busy ? t('editorSaving') : t('editorSave')}
          </button>
        </div>
      )}
    >
      <div className={css.editorLayout}>
        <aside className={css.editorSidebar} aria-label={t('editorFiles')}>
          {tree.status === 'loading' ? <p className={css.hint}>{t('editorLoading')}</p> : null}
          {tree.status === 'error' ? <p className={css.error}>{t('editorTreeError')}</p> : null}
          {tree.status === 'ready' ? (
            <SkillFileTree
              files={tree.tree.files}
              selected={selected}
              truncated={tree.tree.truncated}
              onSelect={setSelected}
            />
          ) : null}
        </aside>
        <section className={css.editorMain}>
          <p className={css.editorPath}>{selected}</p>
          {document?.status === 'loading' ? <p className={css.hint}>{t('editorLoading')}</p> : null}
          {document?.status === 'error' ? <p className={css.error}>{t('editorLoadError')}</p> : null}
          {current === null ? null : (
            <>
              {current.readOnlyReason === undefined ? null : (
                <p className={css.error}>
                  {current.readOnlyReason === 'binary' ? t('editorBinary') : t('editorTooLarge')}
                </p>
              )}
              <SkillFileEditor
                value={text}
                language={language}
                label={selected}
                editable={current.editable}
                onChange={setDraft}
              />
            </>
          )}
        </section>
      </div>
    </Modal>
  )
}
