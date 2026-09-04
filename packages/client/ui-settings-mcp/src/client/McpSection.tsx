/**
 * MCP servers settings section: the user-managed server list with an
 * enable/disable toggle and add/edit/delete flows. The list stays a list; an
 * add or edit opens a dialog over the section rather than expanding a row. An
 * enable toggle writes immediately (it is a single visible decision), while the
 * add/edit form stages and writes only on save. The status dot reflects the
 * live connection status the Host manager reports over the `mcp` Remote
 * namespace, and a refresh button forces one server to reconnect.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpServerStatusView } from '@deepseek-ai/dsh-api-remotes/client'
import { McpServerDialog } from './McpServerDialog.tsx'
import type { McpServerEntry } from './types.ts'
import type { McpStore } from './mcp-store.ts'
import type { McpStatusStore } from './mcp-status-store.ts'
import type { McpKey } from './locales.ts'
import styles from './McpSection.module.css'

/** Injected dependencies of {@link McpSection} (slot `inject`). */
export interface McpSectionInjected {
  /** The server-list store over the `mcp` settings namespace. */
  store: McpStore
  /** The live-status store over the Host `mcp` Remote namespace. */
  status: McpStatusStore
  hooks: {
    /** Server-list snapshot bound by the UI renderer as useMcp. */
    mcp: McpStore['store']
    /** Live-status snapshot bound by the UI renderer as useStatus. */
    status: McpStatusStore['store']
  }
  /** Section copy. */
  t: (key: McpKey) => string
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type McpSectionProps = Partial<InjectFace<McpSectionInjected>>

type McpSectionFace = InjectFace<McpSectionInjected>

/** The status-dot kind for one server row. */
type StatusDot = 'disabled' | 'connected' | 'reconnecting' | 'failed' | 'unknown'

/** Project one server's enabled flag and live status onto the dot kind. */
function statusDot(server: McpServerEntry, view: McpServerStatusView | undefined): StatusDot {
  if (!server.enabled) return 'disabled'
  switch (view?.status) {
    case 'connected': return 'connected'
    case 'connecting':
    case 'reconnecting': return 'reconnecting'
    case 'failed': return 'failed'
    default: return 'unknown'
  }
}

/**
 * Render the MCP servers section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function McpSection(props: McpSectionProps): ReactNode {
  const { store, status, useMcp, useStatus, t } = props
  if (store === undefined || status === undefined || useMcp === undefined || useStatus === undefined || t === undefined) return null
  return <Loaded injected={{ store, status, useMcp, useStatus, t }} />
}

function Loaded({ injected }: { injected: McpSectionFace }): ReactNode {
  const { store, status, useMcp, useStatus, t } = injected
  const state = useMcp(snapshot => snapshot)
  const statusState = useStatus(snapshot => snapshot)
  const [editing, setEditing] = useState<McpServerEntry | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [savedName, setSavedName] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  // Re-pull status whenever the server list changes (add, remove, edit, or
  // toggle), so a newly mounted server's status appears without a manual refresh.
  useEffect(() => {
    if (state.available) void status.load()
  }, [status, state.available, state.servers])

  /** The names of every server except the one the dialog is editing. */
  const existingNames = state.servers
    .filter(server => editing === undefined || server.serverName !== editing.serverName)
    .map(server => server.serverName)

  const saveEntry = (entry: McpServerEntry): void => {
    const write = editing === undefined ? store.add(entry) : store.update(entry)
    void write.then((landed) => {
      if (!landed) {
        setFailure(t('failed'))
        return
      }
      setFailure(undefined)
      setSavedName(entry.serverName)
      setEditing(undefined)
      setAdding(false)
    })
  }

  const toggle = (server: McpServerEntry): void => {
    void store.setEnabled(server.serverName, !server.enabled).then((landed) => {
      setFailure(landed ? undefined : t('failed'))
    })
  }

  const confirmDelete = (): void => {
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    void store.remove(deleteTarget).then((landed) => {
      if (!landed) {
        setFailure(t('failed'))
        return
      }
      setFailure(undefined)
      setDeleteTarget(undefined)
    }).finally(() => { setDeleting(false) })
  }

  const dialogOpen = adding || editing !== undefined
  const dialog = dialogOpen
    ? (
      <McpServerDialog
        entry={editing}
        existingNames={existingNames}
        saving={state.saving}
        onSave={saveEntry}
        onClose={() => {
          setAdding(false)
          setEditing(undefined)
        }}
        t={t}
      />
    )
    : null

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.writable && state.available ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedName === undefined
        ? null
        : <p className={styles['savedNotice']} role="status" aria-live="polite">{t('saved').replace('{server}', savedName)}</p>}
      {failure === undefined ? null : <p className={styles['error']} role="alert">{failure}</p>}
      {state.servers.length === 0
        ? <p className={styles['empty']}>{t('empty')}</p>
        : (
          <ul className={styles['rows']}>
            {state.servers.map((server) => {
              const enabled = server.enabled
              const view = statusState.statuses.get(server.serverName)
              const dot = statusDot(server, view)
              const dotClass = {
                disabled: styles['statusDotDisabled'],
                connected: styles['statusDotConnected'],
                reconnecting: styles['statusDotReconnecting'],
                failed: styles['statusDotFailed'],
                unknown: styles['statusDotUnknown'],
              }[dot]
              const transport = server.transport === 'stdio' ? server.command : server.url
              return (
                <li key={server.serverName} className={styles['rowCard']}>
                  <div className={styles['rowHead']}>
                    <span className={styles['rowIdentity']}>
                      <span
                        className={`${styles['statusDot']} ${dotClass}`}
                        role="img"
                        aria-label={dot}
                        title={dot}
                      />
                      <span className={styles['rowName']}>{server.serverName}</span>
                      <span className={styles['rowTransport']}>{transport}</span>
                      <span className={styles['rowTools']}>
                        {view === undefined ? '' : t('toolsCount').replace('{count}', String(view.tools.length))}
                      </span>
                    </span>
                    <span className={styles['rowActions']}>
                      <button
                        type="button"
                        className={styles['secondaryButton']}
                        disabled={!enabled || statusState.refreshing}
                        aria-label={t('refresh')}
                        title={t('refresh')}
                        onClick={() => { void status.refresh(server.serverName) }}
                      >
                        {t('refresh')}
                      </button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        className={`${styles['toggle']} ${enabled ? styles['toggleOn'] : styles['toggleOff']}`}
                        disabled={!state.writable || state.saving}
                        onClick={() => { toggle(server) }}
                      >
                        <span className={styles['toggleKnob']} />
                      </button>
                      <button
                        type="button"
                        className={styles['secondaryButton']}
                        disabled={!state.writable}
                        onClick={() => {
                          setSavedName(undefined)
                          setFailure(undefined)
                          setAdding(false)
                          setEditing(server)
                        }}
                      >
                        {t('edit')}
                      </button>
                      <button
                        type="button"
                        className={styles['dangerButton']}
                        disabled={!state.writable}
                        onClick={() => {
                          setSavedName(undefined)
                          setFailure(undefined)
                          setDeleteTarget(server.serverName)
                        }}
                      >
                        {t('remove')}
                      </button>
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      <div className={styles['addBlock']}>
        <button
          type="button"
          className={styles['addButton']}
          disabled={!state.writable}
          onClick={() => {
            setSavedName(undefined)
            setFailure(undefined)
            setEditing(undefined)
            setAdding(true)
          }}
        >
          <IconPlusOutline16 size={14} />
          {t('add')}
        </button>
      </div>
      {dialog}
      <Modal
        open={deleteTarget !== undefined}
        onClose={() => {
          if (!deleting) setDeleteTarget(undefined)
        }}
        title={deleteTarget === undefined ? '' : t('deleteTitle').replace('{server}', deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined ? '' : t('deleteDescription').replace('{server}', deleteTarget)}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={() => { setDeleteTarget(undefined) }}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined ? '' : t(deleting ? 'deleting' : 'deleteConfirm').replace('{server}', deleteTarget)}
            </Button>
          </>
        )}
      />
    </div>
  )
}
