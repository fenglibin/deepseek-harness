/**
 * The import dialog: one skill from an uploaded archive or from a URL.
 *
 * Both arms end at the same Host-side unpacking and the same integrity checks,
 * so this component only decides which payload it sends. Resolving a payload is
 * the only way to obtain the preview identity a write addresses, so both footer
 * buttons go through it: "preview" stops there and opens the read-only preview,
 * while "save" resolves and commits in one gesture for a reader who already
 * knows what they are importing.
 *
 * The preview is a separate dialog stacked over this one rather than a region
 * inside it, so inspecting an import never costs the reader the source and
 * target they typed.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ImportPreview,
  ImportPreviewFile,
  ImportPreviewFileRequest,
  ImportPreviewRequest,
  SkillRootView,
  SkillUploadRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillsLocaleKey } from './locales.ts'
import { SkillImportPreviewDialog } from './SkillImportPreviewDialog.tsx'
import css from './SkillsSection.module.css'

/**
 * Largest upload this dialog sends, mirroring the Host's own admission bound.
 *
 * The bound is checked here as well so an oversized file is refused before it
 * is encoded and sent rather than after a multi-megabyte round trip; the Host
 * remains the authority, and its refusal is what a reader sees if the two
 * bounds ever disagree.
 */
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024

/** Which arm of the dialog is showing. */
type ImportTab = 'url' | 'upload'

/** Which footer action is in flight, so only its own button reports progress. */
type ImportAction = 'preview' | 'save'

/** Props of {@link ImportSkillDialog}. */
export interface ImportSkillDialogProps {
  /** Every writable root the import may target. */
  readonly roots: readonly SkillRootView[]
  /** Root preselected from the section's current scope. */
  readonly defaultRoot: string
  /** Workspace the roots were resolved under, forwarded to every Host call. */
  readonly projectRoot: string | undefined
  /** Section copy. */
  readonly t: (key: SkillsLocaleKey, params?: Record<string, string>) => string
  /** Resolve one URL or GitHub location into a preview. */
  readonly previewImport: (request: ImportPreviewRequest) => Promise<ImportPreview>
  /** Resolve one uploaded archive into a preview. */
  readonly previewUpload: (request: SkillUploadRequest) => Promise<ImportPreview>
  /** Read one file of a staged preview for inspection. */
  readonly readPreviewFile: (request: ImportPreviewFileRequest) => Promise<ImportPreviewFile>
  /** Write one approved preview. */
  readonly commitImport: (previewId: string) => Promise<void>
  /** Close the dialog. */
  readonly onClose: () => void
  /** Report that a write landed, so the section reloads its snapshot. */
  readonly onImported: () => void
}

/**
 * Encode one uploaded file as canonical base64.
 *
 * `btoa` takes a binary string, so the bytes are lifted in bounded chunks: one
 * spread across a multi-megabyte array would exceed the argument limit before
 * the encoding ever starts.
 * @param file - the browser's file handle.
 * @returns the canonical base64 encoding of the file's bytes.
 */
async function encodeUpload(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const CHUNK = 0x80_00
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** The skill import dialog. */
export function ImportSkillDialog(props: ImportSkillDialogProps): ReactNode {
  const {
    roots, defaultRoot, projectRoot, t, previewImport, previewUpload, readPreviewFile, commitImport,
    onClose, onImported,
  } = props
  const [tab, setTab] = useState<ImportTab>('upload')
  const [source, setSource] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [rootPath, setRootPath] = useState(defaultRoot)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [busy, setBusy] = useState<ImportAction | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // Both modals listen for Escape on the document, and the stacked preview
  // closes on it. A ref rather than the state value keeps this guard correct
  // whatever order the two modals re-registered their listeners in: Escape must
  // close the top dialog only, never the form underneath it.
  const inspectingRef = useRef(false)
  useEffect(() => { inspectingRef.current = inspecting }, [inspecting])

  // Changing which arm sends the payload invalidates a preview resolved from
  // the other one: the approved list and the pending source must describe the
  // same bytes.
  const switchTab = (next: ImportTab): void => {
    setTab(next)
    setPreview(null)
    setFailure(null)
  }

  /** Resolve the pending payload into a staged preview, reporting its own failure. */
  const resolve = async (): Promise<ImportPreview | null> => {
    try {
      return tab === 'url'
        ? await previewImport({
          source: source.trim(),
          rootPath,
          ...projectRoot === undefined ? {} : { projectRoot },
        })
        : await previewUpload({
          fileName: file?.name ?? '',
          data: await encodeUpload(file as File),
          rootPath,
          ...projectRoot === undefined ? {} : { projectRoot },
        })
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const inspect = async (): Promise<void> => {
    // A preview already resolved from this exact payload is still the one the
    // reader asked to see; resolving again would stage a second copy of the
    // same bytes for no gain.
    if (preview !== null) {
      setFailure(null)
      setInspecting(true)
      return
    }
    setBusy('preview')
    setFailure(null)
    try {
      const resolved = await resolve()
      if (resolved === null) return
      setPreview(resolved)
      setInspecting(true)
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setFailure(null)
    try {
      const resolved = preview ?? await resolve()
      if (resolved === null) return
      // The Host already reached this verdict while staging, and a commit would
      // only be refused by `skill-admin/entry-exists`; reporting the conclusion
      // it published is both cheaper and localized. The Host stays the
      // authority: its own check at the write is untouched, and this is what a
      // reader sees if the two ever disagree.
      if (resolved.replaces) {
        setPreview(resolved)
        setFailure(t('importReplaces'))
        return
      }
      await commitImport(String(resolved.previewId))
      onImported()
      onClose()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const oversized = file !== null && file.size > UPLOAD_MAX_BYTES
  const ready = rootPath !== '' && (tab === 'url' ? source.trim() !== '' : file !== null && !oversized)

  return (
    <>
      <Modal
        open
        onClose={() => { if (!inspectingRef.current) onClose() }}
        title={t('importTitle')}
        closeLabel={t('importCancel')}
        className={css.importDialog ?? ''}
        footer={(
          <div className={css.dialogActions}>
            <span className={css.grow}>{failure === null ? null : <span className={css.error}>{failure}</span>}</span>
            <button className={css.link} type="button" onClick={onClose}>{t('importCancel')}</button>
            <button
              className={css.secondary}
              type="button"
              disabled={busy !== null || !ready}
              onClick={() => { void inspect() }}
            >
              {busy === 'preview' ? t('importLoading') : t('importPreview')}
            </button>
            <button
              className={css.primary}
              type="button"
              disabled={busy !== null || !ready}
              onClick={() => { void save() }}
            >
              {busy === 'save' ? t('importSaving') : t('importSave')}
            </button>
          </div>
        )}
      >
        <div className={css.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'upload'}
            className={tab === 'upload' ? css.tabActive : css.tab}
            onClick={() => { switchTab('upload') }}
          >
            {t('importTabUpload')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'url'}
            className={tab === 'url' ? css.tabActive : css.tab}
            onClick={() => { switchTab('url') }}
          >
            {t('importTabUrl')}
          </button>
        </div>

        <label className={css.field}>
          <span className={css.label}>{t('importTargetRoot')}</span>
          <select
            className={css.control}
            value={rootPath}
            onChange={(event) => {
              setRootPath(event.target.value)
              // A preview resolves against the root it was requested for; changing
              // the target invalidates it, so the approved list and the write never
              // name two different roots.
              setPreview(null)
              setFailure(null)
            }}
          >
            {roots.map(root => <option key={root.path} value={root.path}>{root.path}</option>)}
          </select>
        </label>

        {tab === 'url' ? (
          <label className={css.field}>
            <span className={css.label}>{t('importSource')}</span>
            <input
              className={css.control}
              value={source}
              placeholder={t('importSourceHint')}
              onChange={(event) => {
                setSource(event.target.value)
                // Same rule as the target root: an approved list belongs to the
                // source it was resolved from, so editing it drops the preview.
                setPreview(null)
                setFailure(null)
              }}
            />
          </label>
        ) : (
          <label className={css.field}>
            <span className={css.label}>{t('importFile')}</span>
            <input
              className={css.control}
              type="file"
              aria-label={t('importFile')}
              accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/gzip,application/x-tar"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null)
                setPreview(null)
                setFailure(null)
              }}
            />
            <span className={css.hint}>{t('importFileHint')}</span>
            {file === null ? null : (
              <span className={css.hint}>
                {oversized
                  ? t('importFileTooLarge', { bytes: String(UPLOAD_MAX_BYTES) })
                  : t('importFileChosen', { name: file.name, bytes: String(file.size) })}
              </span>
            )}
          </label>
        )}

        {preview === null ? null : (
          <p className={css.hint}>
            {t('importFiles', { count: String(preview.files.length), bytes: String(preview.totalBytes) })}
            {' · '}{t('importTarget')}：{preview.targetPath}
          </p>
        )}
      </Modal>

      {inspecting && preview !== null ? (
        <SkillImportPreviewDialog
          preview={preview}
          t={t}
          readPreviewFile={readPreviewFile}
          onClose={() => { setInspecting(false) }}
        />
      ) : null}
    </>
  )
}
