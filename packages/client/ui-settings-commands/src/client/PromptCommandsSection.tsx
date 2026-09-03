/**
 * Prompt-command settings page: a list of reusable prompt shortcuts with add,
 * edit, and confirmed delete. The list reads the bound settings scope; each
 * confirmed change commits the whole list as one atomic write, so a change
 * never partially lands.
 */

import { useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptCommandEntry, PromptCommandsController } from './controller.ts'
import { EMPTY_DRAFT, normalizeDraft } from './controller.ts'
import { PromptCommandEditor } from './PromptCommandEditor.tsx'
import type { PromptCommandKey } from './locales.ts'
import css from './PromptCommandsSection.module.css'

/** Registration-side business face: the bound `prompt-commands` controller. */
export interface PromptCommandsSectionInjected {
  controller: PromptCommandsController
}

/** Props the renderer binds for the section. */
export type PromptCommandsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.commands'>
  & InjectFace<PromptCommandsSectionInjected>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Prompt-command settings section copy. */
    'settings.commands': PromptCommandKey
  }
}

/** Editor state: null while closed, else the staged draft and the index being edited (null = add). */
interface EditorState {
  index: number | null
  draft: PromptCommandEntry
}

/**
 * Render the prompt-command list and its editor/confirmation surfaces.
 * @param props - the localized copy reader and the bound controller.
 * @returns the section page.
 */
export function PromptCommandsSection({ t, controller }: PromptCommandsSectionProps) {
  const snapshot = useSyncExternalStore(
    subscribe => controller.subscribe(subscribe),
    () => controller.snapshot(),
  )
  const commands = snapshot.value?.commands ?? []
  // Write controls need a served, writable section; otherwise every confirm
  // would commit to a Host that rejects the write.
  const canWrite = snapshot.status === 'ready' && snapshot.writable
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const openAdd = (): void => {
    setEditor({ index: null, draft: { ...EMPTY_DRAFT } })
  }
  const openEdit = (index: number): void => {
    const command = commands[index]
    if (command === undefined) return
    setEditor({ index, draft: { ...command } })
  }
  const closeEditor = (): void => {
    setEditor(null)
  }
  const saveEditor = (): void => {
    if (editor === null) return
    const normalized = normalizeDraft(editor.draft)
    if (normalized === undefined) return
    const next = editor.index === null
      ? [...commands, normalized]
      : commands.map((command, index) => index === editor.index ? normalized : command)
    void controller.commit(next)
    setEditor(null)
  }
  const requestDelete = (index: number): void => {
    setAcknowledged(false)
    setDeleting(index)
  }
  const confirmDelete = (): void => {
    if (deleting === null) return
    const next = commands.filter((_command, index) => index !== deleting)
    void controller.commit(next)
    setDeleting(null)
  }

  return (
    <div className={css.section}>
      <div className={css.head}>
        <div>
          <h2 className={css.heading}>{t('title')}</h2>
          <p className={css.intro}>{t('emptyHint')}</p>
        </div>
        <Button variant="primary" size="sm" disabled={!canWrite} onClick={openAdd}>{t('add')}</Button>
      </div>

      {!snapshot.writable
        ? <p className={css.readOnly} role="status">{t('readOnly')}</p>
        : null}

      {commands.length === 0
        ? <p className={css.empty}>{t('empty')}</p>
        : (
          <ul className={css.list}>
            {commands.map((command, index) => (
              <li key={`${command.name}-${String(index)}`} className={css.row}>
                <div className={css.rowText}>
                  <span className={css.name}>/{command.name}</span>
                  {command.title !== undefined && command.title !== ''
                    ? <span className={css.title}>{command.title}</span>
                    : null}
                  <span className={css.description}>{command.description}</span>
                </div>
                <div className={css.rowActions}>
                  <Button size="sm" disabled={!canWrite} onClick={() => { openEdit(index) }}>{t('edit')}</Button>
                  <Button size="sm" variant="outline" disabled={!canWrite} onClick={() => { requestDelete(index) }}>{t('delete')}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}

      <PromptCommandEditor
        open={editor !== null}
        title={editor?.index === null ? t('add') : t('edit')}
        draft={editor?.draft ?? { ...EMPTY_DRAFT }}
        t={t}
        onDraftChange={(draft) => {
          setEditor(previous => previous === null ? previous : { ...previous, draft })
        }}
        onCancel={closeEditor}
        onSave={saveEditor}
      />

      <RiskConfirmation
        open={deleting !== null}
        title={t('deleteTitle')}
        description={t('deleteDescription')}
        acknowledgeLabel={t('deleteAcknowledge')}
        cancelLabel={t('deleteCancel')}
        closeLabel={t('deleteCancel')}
        confirmLabel={t('deleteConfirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setDeleting(null) }}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
