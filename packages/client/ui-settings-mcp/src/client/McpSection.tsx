/**
 * MCP servers settings section: the user-managed server list with an
 * enable/disable toggle and edit/delete flows. An edit opens a dialog over the
 * section and writes the single server back into the user-editable `mcp.json`;
 * the "configure" action opens an in-place `mcp.json` editor with syntax
 * highlighting, formatting, and a validated save. An enable toggle writes
 * immediately (it is a single visible decision). The status dot reflects the
 * live connection status the Host manager reports over the `mcp` Remote
 * namespace, and entering the section reconnects every enabled server that is
 * not connected yet.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconChevronDownOutline14, IconChevronRightOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpServerStatusView } from '@deepseek-ai/dsh-api-remotes/client'
import { McpServerDialog } from './McpServerDialog.tsx'
import { McpJsonEditor } from './McpJsonEditor.tsx'
import type { McpServerEntry } from './types.ts'
import type { McpStore } from './mcp-store.ts'
import type { McpStatusStore } from './mcp-status-store.ts'
import type { McpDocumentStore } from './mcp-document-store.ts'
import type { McpKey } from './locales.ts'
import styles from './McpSection.module.css'

/** Injected dependencies of {@link McpSection} (slot `inject`). */
export interface McpSectionInjected {
  /** The server-list store over the `mcp` settings namespace. */
  store: McpStore
  /** The live-status store over the Host `mcp` Remote namespace. */
  status: McpStatusStore
  /** The `mcp.json` document controller; reports `unavailable` when the provider has no local document. */
  document: McpDocumentStore
  hooks: {
    /** Server-list snapshot bound by the UI renderer as useMcp. */
    mcp: McpStore['store']
    /** Live-status snapshot bound by the UI renderer as useStatus. */
    status: McpStatusStore['store']
    /** Configure-document snapshot bound by the UI renderer as useDocument. */
    document: McpDocumentStore['store']
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
  const { store, status, useMcp, useStatus, t, document, useDocument } = props
  if (store === undefined || status === undefined || useMcp === undefined || useStatus === undefined || t === undefined) return null
  if (document === undefined || useDocument === undefined) return null
  return <Loaded injected={{ store, status, useMcp, useStatus, t, document, useDocument }} />
}

function Loaded({ injected }: { injected: McpSectionFace }): ReactNode {
  const { store, status, useMcp, useStatus, t, document, useDocument } = injected
  const state = useMcp(snapshot => snapshot)
  const statusState = useStatus(snapshot => snapshot)
  const doc = useDocument(snapshot => snapshot)
  const [editing, setEditing] = useState<McpServerEntry | undefined>(undefined)
  const [editingDocument, setEditingDocument] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [savedName, setSavedName] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /** Per-server tool list expansion: only a name in the set is currently open. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** Servers already force-reconnected on entry, so a re-pull never re-triggers. */
  const autoConnected = useRef(new Set<string>())

  // Re-pull status whenever the server list changes (add, remove, edit, or
  // toggle), so a newly mounted server's status appears without a manual refresh.
  useEffect(() => {
    if (state.available) void status.load()
  }, [status, state.available, state.servers])

  // Resolve the `mcp.json` document availability and pull its text once.
  useEffect(() => {
    void document.load()
  }, [document])

  // Entering the section connects every enabled server that is not connected.
  // One server at a time: the status store serializes a single refresh, so a
  // parallel fan-out would drop every call after the first. The set of already
  // reconnected names keeps a status re-pull from re-triggering the loop.
  useEffect(() => {
    if (!state.available) return
    const pending = state.servers.filter((server) => {
      if (!server.enabled || autoConnected.current.has(server.serverName)) return false
      const view = statusState.statuses.get(server.serverName)
      return view !== undefined && view.status !== 'connected'
    })
    if (pending.length === 0) return
    void (async () => {
      for (const server of pending) {
        autoConnected.current.add(server.serverName)
        await status.refresh(server.serverName)
      }
    })()
  }, [status, state.available, state.servers, statusState.statuses])

  /** The names of every server except the one the dialog is editing. */
  const existingNames = state.servers
    .filter(server => editing === undefined || server.serverName !== editing.serverName)
    .map(server => server.serverName)

  // The section has no add flow anymore: new servers are pasted into the
  // `mcp.json` editor, so the dialog always edits an existing entry.
  const saveEntry = (entry: McpServerEntry): void => {
    void store.update(entry).then((landed) => {
      if (!landed) {
        setFailure(t('failed'))
        return
      }
      setFailure(undefined)
      setSavedName(entry.serverName)
      setEditing(undefined)
    })
  }

  /** Open the `mcp.json` editor after pulling the latest document text. */
  const openDocumentEditor = (): void => {
    setSavedName(undefined)
    setFailure(undefined)
    setEditingDocument(true)
    void document.read()
  }

  /** Persist one validated document, closing the editor on success. */
  const saveDocument = (text: string): void => {
    void document.write(text).then((landed) => {
      if (landed) setEditingDocument(false)
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

  const dialog = editing !== undefined
    ? (
      <McpServerDialog
        entry={editing}
        existingNames={existingNames}
        saving={state.saving}
        onSave={saveEntry}
        onClose={() => { setEditing(undefined) }}
        t={t}
      />
    )
    : null

  return (
    <div className={styles['section']}>
      <div className={styles['head']}>
        <h2 className={styles['title']}>{t('title')}</h2>
        {doc.status !== 'ready'
          ? null
          : (
            <div className={styles['configure']}>
              <button
                type="button"
                className={styles['configureButton']}
                disabled={doc.opening}
                onClick={openDocumentEditor}
              >
                {t('configure')}
              </button>
            </div>
          )}
      </div>
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
              const tools = view?.tools ?? []
              const isExpanded = expanded.has(server.serverName)
              const toggleExpanded = (): void => {
                setExpanded((previous) => {
                  const next = new Set(previous)
                  if (next.has(server.serverName)) next.delete(server.serverName)
                  else next.add(server.serverName)
                  return next
                })
              }
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
                      <button
                        type="button"
                        className={styles['toolsToggle']}
                        disabled={tools.length === 0}
                        aria-expanded={isExpanded}
                        aria-controls={`mcp-tools-${server.serverName}`}
                        title={tools.length === 0 ? t('noTools') : (isExpanded ? t('collapseTools') : t('expandTools'))}
                        onClick={toggleExpanded}
                      >
                        {isExpanded
                          ? <IconChevronDownOutline14 size={12} />
                          : <IconChevronRightOutline14 size={12} />}
                        <span>{t('toolsCount').replace('{count}', String(tools.length))}</span>
                      </button>
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
                  {dot === 'failed' && view?.error !== undefined
                    ? <p className={styles['rowError']} role="alert">{view.error}</p>
                    : null}
                  {isExpanded && tools.length > 0
                    ? (
                      <ul
                        id={`mcp-tools-${server.serverName}`}
                        className={styles['toolsList']}
                        aria-label={t('expandTools')}
                      >
                        {tools.map(tool => (
                          <li key={tool.name} className={styles['toolsItem']}>
                            <span className={styles['toolsName']} title={tool.description}>{tool.name}</span>
                            {tool.description !== ''
                              ? <span className={styles['toolsDescription']}>{tool.description}</span>
                              : null}
                          </li>
                        ))}
                      </ul>
                    )
                    : null}
                </li>
              )
            })}
          </ul>
        )}
      {dialog}
      {editingDocument
        ? (
          <McpJsonEditor
            text={doc.text}
            opening={doc.opening}
            error={doc.error}
            onSave={saveDocument}
            onClose={() => { setEditingDocument(false) }}
            t={t}
          />
        )
        : null}
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
