/**
 * The import preview dialog: the staged file list a commit would write,
 * presented the way the editor presents a skill — a tree beside the selected
 * file's content.
 *
 * Approving an import is the same judgement as editing one, so the layout is
 * deliberately the editor's. The difference is the one that matters: every file
 * here is read-only, because the bytes a commit writes are the bytes the
 * archive carried. Inspecting a staged import and writing it are separate
 * gestures, and this dialog only performs the first.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ImportPreview,
  ImportPreviewFile,
  ImportPreviewFileRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillsLocaleKey } from './locales.ts'
import { SkillFileEditor, languageOf } from './SkillFileEditor.tsx'
import { SkillFileTree } from './SkillFileTree.tsx'
import css from './SkillsSection.module.css'

/** What the dialog knows about the staged file it is showing. */
type InspectedState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly file: ImportPreviewFile }

/** Props of {@link SkillImportPreviewDialog}. */
export interface SkillImportPreviewDialogProps {
  /** The staged import being inspected. */
  readonly preview: ImportPreview
  /** Section copy. */
  readonly t: (key: SkillsLocaleKey, params?: Record<string, string>) => string
  /** Read one file of the staged preview. */
  readonly readPreviewFile: (request: ImportPreviewFileRequest) => Promise<ImportPreviewFile>
  /** Close the dialog, returning the reader to the import form. */
  readonly onClose: () => void
}

/** The import preview dialog. */
export function SkillImportPreviewDialog(props: SkillImportPreviewDialogProps): ReactNode {
  const { preview, t, readPreviewFile, onClose } = props
  const [selected, setSelected] = useState('')
  const [inspected, setInspected] = useState<InspectedState>({ status: 'loading' })

  // The entry point is what a reader judges first; the first member is the
  // fallback for an archive that carries no SKILL.md at its root.
  useEffect(() => {
    const entryPoint = preview.files.find(member => member.path === 'SKILL.md') ?? preview.files[0]
    setSelected(entryPoint?.path ?? '')
  }, [preview])

  useEffect(() => {
    if (selected === '') return
    let live = true
    setInspected({ status: 'loading' })
    void (async () => {
      try {
        const read = await readPreviewFile({ previewId: preview.previewId, path: selected })
        if (live) setInspected({ status: 'ready', file: read })
      } catch {
        if (live) setInspected({ status: 'error' })
      }
    })()
    return () => { live = false }
  }, [preview, readPreviewFile, selected])

  return (
    <Modal
      open
      onClose={onClose}
      title={t('importPreviewTitle', { name: preview.name })}
      closeLabel={t('importPreviewClose')}
      className={css.previewDialog ?? ''}
      bodyClassName={css.editorBody ?? ''}
      footer={(
        <div className={css.dialogActions}>
          <button className={css.link} type="button" onClick={onClose}>{t('importPreviewBack')}</button>
        </div>
      )}
    >
      <div className={css.previewHead}>
        <p className={css.hint}>
          {t('importFiles', { count: String(preview.files.length), bytes: String(preview.totalBytes) })}
          {' · '}{t('importTarget')}：{preview.targetPath}
        </p>
        {preview.replaces ? <p className={css.error}>{t('importReplaces')}</p> : null}
      </div>
      <div className={css.editorLayout}>
        <aside className={css.editorSidebar} aria-label={t('editorFiles')}>
          <SkillFileTree
            files={preview.files}
            selected={selected}
            truncated={false}
            onSelect={setSelected}
          />
        </aside>
        <section className={css.editorMain}>
          <p className={css.editorPath}>{selected}</p>
          {inspected.status === 'loading' ? <p className={css.hint}>{t('editorLoading')}</p> : null}
          {inspected.status === 'error' ? <p className={css.error}>{t('editorLoadError')}</p> : null}
          {inspected.status === 'ready' ? (
            <>
              {inspected.file.unreadableReason === undefined ? null : (
                <p className={css.error}>
                  {inspected.file.unreadableReason === 'binary' ? t('editorBinary') : t('editorTooLarge')}
                </p>
              )}
              <SkillFileEditor
                value={inspected.file.text}
                language={languageOf(selected)}
                label={selected}
                /* A staged preview is inspected, never edited: the bytes a
                   commit writes are the bytes the archive carried. */
                editable={false}
                onChange={() => {}}
              />
            </>
          ) : null}
        </section>
      </div>
    </Modal>
  )
}
