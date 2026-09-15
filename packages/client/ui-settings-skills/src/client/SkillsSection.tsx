/**
 * The skills Settings section: the three scope tabs, the table of skills one
 * scope holds, and the dialogs every write goes through.
 *
 * Every rendered fact comes from the Host snapshot, so the section keeps only
 * its own navigation, dialog, and in-flight state. Creating a skill is not a
 * page action any more: a skill arrives by import, and both the editor and the
 * import dialog are modal so the list itself stays a list.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ImportPreview,
  ImportPreviewFile,
  ImportPreviewFileRequest,
  ImportPreviewRequest,
  SkillAdminEntry,
  SkillAdminSnapshot,
  SkillFileDocument,
  SkillFileTree,
  SkillFileWriteRequest,
  SkillRootView,
  SkillUploadRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ImportSkillDialog } from './ImportSkillDialog.tsx'
import { SkillEditorDialog } from './SkillEditorDialog.tsx'
import { SkillsList } from './SkillsList.tsx'
import { SKILL_SCOPES, rootsInScope, type SkillScope } from './scope.ts'
import css from './SkillsSection.module.css'

/** Registration-side Remote face used by the section. */
export interface SkillsSectionInjected {
  /** Read the management view of one workspace; omission lists global roots alone. */
  list: (projectRoot?: string) => Promise<SkillAdminSnapshot>
  /** Remove one entry. */
  remove: (entryId: string, projectRoot?: string) => Promise<void>
  /** Move one entry between discovery's reach and its root's disabled parking directory. */
  setEnabled: (entryId: string, enabled: boolean, projectRoot?: string) => Promise<SkillAdminEntry>
  /** List one entry's files. */
  listFiles: (entryId: string, projectRoot?: string) => Promise<SkillFileTree>
  /** Read one of an entry's files. */
  readFile: (entryId: string, path: string, projectRoot?: string) => Promise<SkillFileDocument>
  /** Replace one of an entry's files. */
  writeFile: (request: SkillFileWriteRequest) => Promise<void>
  /** Resolve a URL or GitHub location into a preview. */
  previewImport: (request: ImportPreviewRequest) => Promise<ImportPreview>
  /** Resolve an uploaded archive into a preview. */
  previewUpload: (request: SkillUploadRequest) => Promise<ImportPreview>
  /** Read one file of a staged preview for inspection. */
  readPreviewFile: (request: ImportPreviewFileRequest) => Promise<ImportPreviewFile>
  /** Write one approved preview. */
  commitImport: (previewId: string) => Promise<void>
}

/** Full component props assembled by the Settings slot renderer. */
export type SkillsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.skills'>
  & InjectFace<SkillsSectionInjected>

/** What the section currently knows about its Host view. */
type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: SkillAdminSnapshot }

/** The label one scope tab shows. */
const SCOPE_LABELS = {
  global: 'scopeGlobal',
  app: 'scopeApp',
  workspace: 'scopeWorkspace',
} as const

/** The skills Settings section. */
export function SkillsSection(props: SkillsSectionProps): ReactNode {
  const {
    t, list, remove, setEnabled, listFiles, readFile, writeFile, previewImport, previewUpload,
    readPreviewFile, commitImport,
  } = props
  const workspaces = props.useWorkspaces(state => state.items)
  const [scope, setScope] = useState<SkillScope>('global')
  const [projectRoot, setProjectRoot] = useState('')
  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [editing, setEditing] = useState<SkillAdminEntry | null>(null)
  const [importing, setImporting] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<SkillAdminEntry | null>(null)

  // The global and app scopes resolve from global roots alone, so only the
  // workspace scope sends a directory — and only a selected one: guessing a cwd
  // would let the page write into a project the reader never chose.
  const listedRoot = scope === 'workspace' && projectRoot !== '' ? projectRoot : undefined

  const refresh = useCallback(async () => {
    setView({ status: 'loading' })
    try {
      setView({ status: 'ready', snapshot: await list(listedRoot) })
    } catch {
      setView({ status: 'error' })
    }
  }, [list, listedRoot])

  useEffect(() => { void refresh() }, [refresh])

  // A dialog belongs to the workspace it was opened under: its entry resolves
  // against a project root the reader may have just replaced.
  useEffect(() => {
    setEditing(null)
    setImporting(false)
  }, [projectRoot])

  const allRoots: readonly SkillRootView[] = view.status === 'ready' ? view.snapshot.roots : []
  const roots = rootsInScope(allRoots, scope)
  // Import targets are the writable roots of the scope on screen: a root no pane
  // shows would let a reader import a skill into a place they then cannot find.
  const importRoots = roots.filter(root => root.writable)
  const defaultImportRoot = importRoots[0]?.path ?? ''
  const workspaceChosen = scope !== 'workspace' || projectRoot !== ''
  const empty = roots.every(root => root.entries.length === 0)

  const toggle = async (entry: SkillAdminEntry, enabled: boolean): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      await setEnabled(String(entry.entryId), enabled, listedRoot)
      await refresh()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const confirmRemoval = async (): Promise<void> => {
    /* v8 ignore next -- defensive: the confirm control renders only inside a dialog that exists while a pending removal is set. */
    if (pendingRemoval === null) return
    setBusy(true)
    setFailure(null)
    try {
      await remove(String(pendingRemoval.entryId), listedRoot)
      setPendingRemoval(null)
      await refresh()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.section}>
      <div className={css.toolbar}>
        <div className={css.tabs} role="tablist">
          {SKILL_SCOPES.map(candidate => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={candidate === scope}
              className={candidate === scope ? css.tabActive : css.tab}
              onClick={() => { setScope(candidate) }}
            >
              {t(SCOPE_LABELS[candidate])}
            </button>
          ))}
        </div>
        <span className={css.grow} />
        {scope === 'workspace' ? (
          <label className={css.field}>
            <select
              className={css.control}
              value={projectRoot}
              onChange={(event) => { setProjectRoot(event.target.value) }}
            >
              <option value="">{t('workspacePlaceholder')}</option>
              {workspaces.map(workspace => (
                <option key={workspace.workspaceId} value={workspace.path}>{workspace.title}</option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          className={css.primary}
          type="button"
          disabled={importRoots.length === 0}
          onClick={() => { setImporting(true) }}
        >
          {t('importSkill')}
        </button>
      </div>

      {failure === null ? null : <p className={css.error} role="alert">{failure}</p>}

      {/* Both `.agents` roots are shared with other agent tools, so a skill
          parked or deleted here is not private to this deployment. */}
      {roots.some(root => root.source === 'user-agents' || root.source === 'project-agents')
        ? <p className={css.hint}>{t('sharedRoot')}</p>
        : null}

      {view.status === 'loading' ? <p className={css.hint}>{t('loading')}</p> : null}
      {view.status === 'error' ? (
        <p className={css.error}>
          {t('error')}
          <button className={css.link} type="button" onClick={() => { void refresh() }}>{t('retry')}</button>
        </p>
      ) : null}
      {view.status === 'ready' && !workspaceChosen ? <p className={css.hint}>{t('workspaceEmpty')}</p> : null}
      {view.status === 'ready' && workspaceChosen && empty ? <p className={css.hint}>{t('empty')}</p> : null}
      {view.status === 'ready' && workspaceChosen && !empty ? (
        <SkillsList
          roots={roots}
          t={t}
          busy={busy}
          onToggle={(entry, enabled) => { void toggle(entry, enabled) }}
          onEdit={setEditing}
          onRemove={setPendingRemoval}
        />
      ) : null}

      {editing === null ? null : (
        <SkillEditorDialog
          entry={editing}
          projectRoot={listedRoot}
          t={t}
          listFiles={listFiles}
          readFile={readFile}
          writeFile={writeFile}
          onClose={() => { setEditing(null) }}
          onSaved={() => { void refresh() }}
        />
      )}

      {importing ? (
        <ImportSkillDialog
          roots={importRoots}
          defaultRoot={defaultImportRoot}
          projectRoot={listedRoot}
          t={t}
          previewImport={previewImport}
          previewUpload={previewUpload}
          readPreviewFile={readPreviewFile}
          commitImport={commitImport}
          onClose={() => { setImporting(false) }}
          onImported={() => { void refresh() }}
        />
      ) : null}

      <Modal
        open={pendingRemoval !== null}
        onClose={() => { setPendingRemoval(null) }}
        title={t('removeTitle')}
        closeLabel={t('removeCancel')}
        footer={(
          <div className={css.dialogActions}>
            <button className={css.link} type="button" onClick={() => { setPendingRemoval(null) }}>
              {t('removeCancel')}
            </button>
            <button className={css.danger} type="button" disabled={busy} onClick={() => { void confirmRemoval() }}>
              {busy ? t('removing') : t('removeConfirm')}
            </button>
          </div>
        )}
      >
        <p className={css.hint}>
          {pendingRemoval === null ? '' : t('removeBody', { path: pendingRemoval.path })}
        </p>
      </Modal>
    </div>
  )
}
