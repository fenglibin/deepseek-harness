/**
 * Add/edit dialog for one MCP server. The form stages what the user types and
 * writes only when they save, so a control never commits as it settles. The
 * `env` and `headers` maps are edited as one `KEY=value` per line; a blank
 * line or an unparsable line is dropped rather than written.
 * The `serverName` is read-only when editing an existing entry, because it is
 * the stable identity the manager and every tool name are keyed by.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpServerEntry, McpStdioServer, McpHttpServer } from './types.ts'
import type { McpKey } from './locales.ts'
import styles from './McpServerDialog.module.css'

/** Valid `serverName`, kept identical to the manager's namespace contract. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Draft text fields the dialog stages before one save. */
interface McpServerDraft {
  serverName: string
  enabled: boolean
  transport: 'stdio' | 'streamable-http'
  command: string
  args: string
  cwd: string
  url: string
  env: string
  headers: string
}

/** Serialize one `KEY=value` map into editable lines. */
function formatMap(map: Record<string, string>): string {
  return Object.entries(map).map(([key, value]) => `${key}=${value}`).join('\n')
}

/** Parse `KEY=value` lines back into a map, dropping blank and malformed lines. */
function parseMap(text: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (key === '') continue
    map[key] = trimmed.slice(separator + 1).trim()
  }
  return map
}

/** Split space-separated arguments, dropping empties. */
function parseArgs(text: string): string[] {
  return text.trim() === '' ? [] : text.trim().split(/\s+/)
}

/** Build the entry one draft produces, or undefined when a field is not accepted. */
function toEntry(draft: McpServerDraft, existingNames: readonly string[]): McpServerEntry | undefined {
  if (!SERVER_NAME_PATTERN.test(draft.serverName)) return undefined
  if (existingNames.includes(draft.serverName)) return undefined
  if (draft.transport === 'stdio') {
    if (draft.command.trim() === '') return undefined
    const entry: McpStdioServer = {
      serverName: draft.serverName,
      enabled: draft.enabled,
      transport: 'stdio',
      command: draft.command.trim(),
      args: parseArgs(draft.args),
      cwd: draft.cwd.trim(),
      env: parseMap(draft.env),
    }
    return entry
  }
  if (draft.url.trim() === '') return undefined
  const entry: McpHttpServer = {
    serverName: draft.serverName,
    enabled: draft.enabled,
    transport: 'streamable-http',
    url: draft.url.trim(),
    headers: parseMap(draft.headers),
  }
  return entry
}

/** Draft from an existing entry, or the add defaults when none is given. */
function fromEntry(entry: McpServerEntry | undefined): McpServerDraft {
  if (entry === undefined) {
    return {
      serverName: '', enabled: true, transport: 'stdio',
      command: '', args: '', cwd: '', url: '', env: '', headers: '',
    }
  }
  if (entry.transport === 'stdio') {
    return {
      serverName: entry.serverName, enabled: entry.enabled, transport: 'stdio',
      command: entry.command, args: entry.args.join(' '), cwd: entry.cwd,
      url: '', env: formatMap(entry.env), headers: '',
    }
  }
  return {
    serverName: entry.serverName, enabled: entry.enabled, transport: 'streamable-http',
    command: '', args: '', cwd: '', url: entry.url, env: '', headers: formatMap(entry.headers),
  }
}

/** Which validation failure the current draft has, if any. */
function validation(draft: McpServerDraft, existingNames: readonly string[]): McpKey | undefined {
  if (!SERVER_NAME_PATTERN.test(draft.serverName)) return 'serverNameInvalid'
  if (existingNames.includes(draft.serverName)) return 'serverNameDuplicate'
  if (draft.transport === 'stdio' && draft.command.trim() === '') return 'commandRequired'
  if (draft.transport === 'streamable-http' && draft.url.trim() === '') return 'urlRequired'
  return undefined
}

/** Props delivered by {@link McpSection} to the add/edit dialog. */
export interface McpServerDialogProps {
  /** The entry being edited; undefined for the add flow. */
  entry: McpServerEntry | undefined
  /** Names of every other server, so the draft can reject a duplicate. */
  existingNames: readonly string[]
  /** Whether a save is crossing the wire; disables the save action. */
  saving: boolean
  /** Write the staged entry. */
  onSave: (entry: McpServerEntry) => void
  /** Close the dialog without saving. */
  onClose: () => void
  /** Section copy. */
  t: (key: McpKey) => string
}

/**
 * Render the add/edit dialog.
 * @param props - the entry (or add), the sibling names, and the save/close actions.
 * @returns the dialog.
 */
export function McpServerDialog(props: McpServerDialogProps): ReactNode {
  const { entry, existingNames, saving, onSave, onClose, t } = props
  const [draft, setDraft] = useState<McpServerDraft>(() => fromEntry(entry))
  const invalid = validation(draft, existingNames)
  const editing = entry !== undefined

  const set = (patch: Partial<McpServerDraft>): void => {
    setDraft(previous => ({ ...previous, ...patch }))
  }

  const submit = (): void => {
    if (invalid !== undefined || saving) return
    const built = toEntry(draft, existingNames)
    if (built === undefined) return
    onSave(built)
  }

  const title = editing ? t('editTitle').replace('{server}', entry.serverName) : t('addTitle')

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t('close')}
      className={styles['dialog'] as string}
      footer={(
        <>
          <Button variant="outline" autoFocus disabled={saving} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="outline" disabled={invalid !== undefined || saving} onClick={submit}>
            {saving ? t('saving') : t('save')}
          </Button>
        </>
      )}
    >
      <div className={styles['form']}>
        <label className={styles['field']}>
          <span className={styles['label']}>{t('serverName')}</span>
          <input
            type="text"
            value={draft.serverName}
            disabled={editing}
            onChange={(event) => { set({ serverName: event.target.value }) }}
          />
        </label>
        <label className={styles['field']}>
          <span className={styles['label']}>{t('transport')}</span>
          <select
            value={draft.transport}
            disabled={editing}
            onChange={(event) => {
              set({ transport: event.target.value === 'streamable-http' ? 'streamable-http' : 'stdio' })
            }}
          >
            <option value="stdio">{t('transportStdio')}</option>
            <option value="streamable-http">{t('transportStreamableHttp')}</option>
          </select>
        </label>
        {draft.transport === 'stdio'
          ? (
            <>
              <label className={styles['field']}>
                <span className={styles['label']}>{t('command')}</span>
                <input
                  type="text"
                  value={draft.command}
                  onChange={(event) => { set({ command: event.target.value }) }}
                />
              </label>
              <label className={styles['field']}>
                <span className={styles['label']}>{t('args')}</span>
                <input
                  type="text"
                  value={draft.args}
                  placeholder={t('argsHint')}
                  onChange={(event) => { set({ args: event.target.value }) }}
                />
              </label>
              <label className={styles['field']}>
                <span className={styles['label']}>{t('cwd')}</span>
                <input
                  type="text"
                  value={draft.cwd}
                  onChange={(event) => { set({ cwd: event.target.value }) }}
                />
              </label>
              <label className={styles['field']}>
                <span className={styles['label']}>{t('env')}</span>
                <textarea
                  value={draft.env}
                  placeholder={t('envHint')}
                  onChange={(event) => { set({ env: event.target.value }) }}
                />
              </label>
            </>
          )
          : (
            <>
              <label className={styles['field']}>
                <span className={styles['label']}>{t('url')}</span>
                <input
                  type="text"
                  value={draft.url}
                  onChange={(event) => { set({ url: event.target.value }) }}
                />
              </label>
              <label className={styles['field']}>
                <span className={styles['label']}>{t('headers')}</span>
                <textarea
                  value={draft.headers}
                  placeholder={t('headersHint')}
                  onChange={(event) => { set({ headers: event.target.value }) }}
                />
              </label>
            </>
          )}
        <label className={styles['check']}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => { set({ enabled: event.target.checked }) }}
          />
          <span>{t('enabledLabel')}</span>
        </label>
        {invalid === undefined ? null : <p className={styles['error']}>{t(invalid)}</p>}
      </div>
    </Modal>
  )
}
