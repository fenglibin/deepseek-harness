import { useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconDownloadOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog.tsx'
import css from './HeaderAction.module.css'

/** Menu row ids: the archive range each row exports. */
type SessionLogScopeId = 'current' | 'tree'

/**
 * Render the Session Header export capsule, its range menu, and the shared failure dialog.
 * @param props - Session runtime, download controller, and localized dialog copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadDialogProps): ReactNode {
  const { sessionId, useSessionLogDownload, request, t } = props
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'
  const [open, setOpen] = useState(false)

  const items = [
    { id: 'current' satisfies SessionLogScopeId, label: t('header.scopeCurrent') },
    { id: 'tree' satisfies SessionLogScopeId, label: t('header.scopeTree') },
  ]

  return (
    <>
      <div className={css.sessionLogCluster}>
        <button
          type="button"
          className={css.sessionLogButton}
          disabled={busy}
          aria-busy={busy}
          onClick={() => { void request(sessionId) }}
        >
          <span>{t('header.action')}</span>
          <IconDownloadOutline16 size={12} />
        </button>
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={items}
          selectedId="current"
          onSelect={(id) => {
            setOpen(false)
            void request(sessionId, id === 'tree')
          }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className={css.sessionLogMenuButton}
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={t('header.menu')}
              onClick={() => { setOpen(value => !value) }}
            >
              <IconChevronDownOutline14 />
            </button>
          )}
        />
      </div>
      <SessionLogDownloadDialog {...props} />
    </>
  )
}
