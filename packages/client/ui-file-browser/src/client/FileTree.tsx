/**
 * The workspace file tree: one lazily loaded level at a time, with the row
 * verbs (rename, delete).
 *
 * A directory's children are fetched the first time it expands and cached in
 * this component's state; collapsing does not discard them, so reopening a
 * directory is instant. Every mutation reports back to the owner, which owns
 * the Remote call and refreshes the affected level — the tree never writes.
 *
 * The create verbs live on the dialog's toolbar rather than here: they act on
 * the tree's current selection, which the dialog already owns.
 */
import { useState } from 'react'
import clsx from 'clsx'
import {
  IconCodeOutline16, IconFolderClose16, IconFolderOpen16, IconEllipsisOutline16,
  IconLoadingOutline16, IconTriangleRightFill14, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileBrowserEntry } from '@deepseek-ai/dsh-api-file-browser/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import css from './FileTree.module.css'

/** One directory level: its children, whether it is still loading, and any failure. */
export interface TreeLevel {
  entries: readonly FileBrowserEntry[]
  truncated: boolean
  loading: boolean
  error?: string | undefined
}

/** Actions the tree reports upward; the owner performs every Remote call. */
export interface FileTreeActions {
  /** Load one level (the root when `path` is empty). */
  load: (path: string) => void
  /** Select a file for the content pane. */
  select: (path: string) => void
  /** Make a directory the create destination (`''` is the root). */
  selectDirectory: (path: string) => void
  /** Start the rename flow for one entry. */
  rename: (entry: FileBrowserEntry) => void
  /** Start the delete flow for one entry. */
  remove: (entry: FileBrowserEntry) => void
}

/** Props of {@link FileTree}. */
export interface FileTreeProps {
  /** Loaded levels keyed by workspace-relative directory path (`''` is the root). */
  levels: ReadonlyMap<string, TreeLevel>
  /** Directories currently expanded, by path. */
  expanded: ReadonlySet<string>
  /** Toggle one directory's expansion (the owner fetches on first open). */
  onToggle: (path: string) => void
  /** The selected file's workspace-relative path. */
  selected?: string | undefined
  /**
   * The selected directory's workspace-relative path (`''` for the root). A
   * create lands inside it, so it is tracked apart from `selected`: clicking a
   * directory both expands it and makes it the create destination.
   */
  selectedDirectory?: string | undefined
  /** Row and create verbs. */
  actions: FileTreeActions
  /** Localized chrome. */
  t: TranslateNS<'fileBrowser'>
}

/** Indentation per tree depth, in pixels. */
const INDENT_PER_DEPTH = 14

/**
 * Render the file tree.
 * @param props - see {@link FileTreeProps}.
 * @returns the tree element.
 */
export function FileTree({ levels, expanded, onToggle, selected, selectedDirectory, actions, t }: FileTreeProps) {
  const [menuPath, setMenuPath] = useState<string | undefined>(undefined)

  /**
   * One directory's children. Plain functions rather than `useCallback`: the
   * two are mutually recursive (a directory renders its own level, which
   * renders entries, which render their directory), and a memoized pair would
   * capture a stale sibling — the entry rows would then render against an
   * outdated `menuPath` and their row menus could never open.
   */
  const renderLevel = (path: string, depth: number): React.ReactNode => {
    const level = levels.get(path)
    if (level === undefined || level.loading) {
      return (
        <div className={css.notice} style={{ paddingLeft: `${String(depth * INDENT_PER_DEPTH + 8)}px` }}>
          {level?.loading !== false && <IconLoadingOutline16 />}
          <span>{t('tree.loading')}</span>
        </div>
      )
    }
    if (level.error !== undefined) {
      return (
        <div className={css.error} role="alert" style={{ paddingLeft: `${String(depth * INDENT_PER_DEPTH + 8)}px` }}>
          <span>{level.error}</span>
          <button type="button" className={css.linkButton} onClick={() => { actions.load(path) }}>
            {t('tree.retry')}
          </button>
        </div>
      )
    }
    if (level.entries.length === 0) {
      return (
        <div className={css.notice} style={{ paddingLeft: `${String(depth * INDENT_PER_DEPTH + 8)}px` }}>
          {t('tree.empty')}
        </div>
      )
    }
    return (
      <>
        {level.entries.map(entry => renderEntry(entry, depth))}
        {level.truncated && (
          <div className={css.notice} style={{ paddingLeft: `${String(depth * INDENT_PER_DEPTH + 8)}px` }}>
            {t('tree.truncated')}
          </div>
        )}
      </>
    )
  }

  /** One entry row plus, for an expanded directory, its children. */
  const renderEntry = (entry: FileBrowserEntry, depth: number): React.ReactNode => {
    const isDirectory = entry.kind === 'directory'
    const isOpen = isDirectory && expanded.has(entry.path)
    const isSelected = isDirectory ? entry.path === selectedDirectory : entry.path === selected
    const menuItems: MenuEntry[] = [
      { id: 'rename', label: t('file.rename') },
      { id: 'delete', label: t('file.delete'), danger: true },
    ]
    return (
      <div key={entry.path}>
        <div
          className={clsx(css.row, isSelected && css.selected)}
          role="treeitem"
          aria-selected={isSelected}
          aria-expanded={isDirectory ? isOpen : undefined}
          style={{ paddingLeft: `${String(depth * INDENT_PER_DEPTH + 4)}px` }}
          onClick={() => {
            // A directory click both selects it (the create destination) and
            // toggles it; a file click opens it in the content pane.
            if (isDirectory) {
              actions.selectDirectory(entry.path)
              onToggle(entry.path)
            } else actions.select(entry.path)
          }}
        >
          <span className={css.chevron}>
            {isDirectory && <IconTriangleRightFill14 className={clsx(css.arrow, isOpen && css.arrowOpen)} />}
          </span>
          <span className={css.icon}>
            {isDirectory
              ? (isOpen ? <IconFolderOpen16 /> : <IconFolderClose16 />)
              : <IconCodeOutline16 />}
          </span>
          <span className={css.name} title={entry.name}>{entry.name}</span>
          <span className={css.rowActions}>
            <Menu
              open={menuPath === entry.path}
              onClose={() => { setMenuPath(undefined) }}
              items={menuItems}
              onSelect={(id) => {
                setMenuPath(undefined)
                if (id === 'rename') actions.rename(entry)
                if (id === 'delete') actions.remove(entry)
              }}
              portal
              closeOnPointerLeave
              anchor={(
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('tree.actions.aria', { name: entry.name })}
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuPath(current => (current === entry.path ? undefined : entry.path))
                  }}
                >
                  <IconEllipsisOutline16 />
                </button>
              )}
            />
          </span>
        </div>
        {isOpen && <div role="group">{renderLevel(entry.path, depth + 1)}</div>}
      </div>
    )
  }

  return (
    <div className={css.tree}>
      <div className={css.body} role="tree" aria-label={t('tree.aria')}>
        {renderLevel('', 0)}
      </div>
    </div>
  )
}
