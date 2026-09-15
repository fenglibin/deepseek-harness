/**
 * The skill editor's file tree.
 *
 * The Host lists files as forward-slash paths relative to the entry's file
 * root, so the tree is rebuilt here from those paths rather than from a nested
 * structure: one flat list is what the wire carries, and a directory in it only
 * exists because some file mentions it.
 */

import { Fragment, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { SkillFileNode } from '@deepseek-ai/dsh-api-remotes/client'
import css from './SkillsSection.module.css'

/** Props of {@link SkillFileTree}. */
export interface SkillFileTreeProps {
  /** Files the Host listed. */
  readonly files: readonly SkillFileNode[]
  /** File the editor currently shows. */
  readonly selected: string
  /** Select one file by its relative path. */
  readonly onSelect: (path: string) => void
  /** Whether the listing stopped at a bound, in which case the tree is partial. */
  readonly truncated: boolean
}

/** One leaf of the rebuilt tree. */
interface FileLeaf {
  readonly path: string
  readonly name: string
}

/** One directory of the rebuilt tree. */
interface TreeDirectory {
  readonly name: string
  readonly path: string
  readonly directories: TreeDirectory[]
  readonly files: FileLeaf[]
}

/** Rebuild the directory structure the listed paths imply. */
function buildTree(files: readonly SkillFileNode[]): TreeDirectory {
  const root: TreeDirectory = { name: '', path: '', directories: [], files: [] }
  for (const file of files) {
    const segments = file.path.split('/')
    const name = segments.pop() ?? file.path
    let current = root
    let prefix = ''
    for (const segment of segments) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`
      let next = current.directories.find(candidate => candidate.name === segment)
      if (next === undefined) {
        next = { name: segment, path: prefix, directories: [], files: [] }
        current.directories.push(next)
      }
      current = next
    }
    current.files.push({ path: file.path, name })
  }
  return root
}

/** The editor's file tree. */
export function SkillFileTree({ files, selected, onSelect, truncated }: SkillFileTreeProps): ReactNode {
  const tree = useMemo(() => buildTree(files), [files])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  return (
    <div className={css.tree}>
      {renderDirectory(tree, 0, collapsed, setCollapsed, selected, onSelect)}
      {truncated ? <p className={css.treeTruncated}>…</p> : null}
    </div>
  )
}

/**
 * Render one directory's children.
 *
 * Every row comes back as a direct child of the tree container, nesting
 * included, and no directory wraps its own rows: a wrapper would be an ordinary
 * block box, and the rows inside it — buttons, which are inline-block — would
 * share a line, so a nested file would sit beside the directory that holds it.
 * Depth survives as the `--tree-depth` indentation the stylesheet reads.
 * @param directory - the directory to render.
 * @param depth - its nesting level, which the stylesheet turns into indentation.
 * @param collapsed - directories the reader closed.
 * @param setCollapsed - replace the closed-directory set.
 * @param selected - the file the editor shows.
 * @param onSelect - select one file.
 * @returns the rows for this directory, depth first.
 */
function renderDirectory(
  directory: TreeDirectory,
  depth: number,
  collapsed: ReadonlySet<string>,
  setCollapsed: (next: ReadonlySet<string>) => void,
  selected: string,
  onSelect: (path: string) => void,
): ReactNode {
  return (
    <>
      {directory.files.map(file => (
        <button
          key={file.path}
          type="button"
          className={file.path === selected ? css.treeFileActive : css.treeFile}
          style={{ '--tree-depth': depth } as CSSProperties}
          aria-current={file.path === selected}
          onClick={() => { onSelect(file.path) }}
        >
          {file.name}
        </button>
      ))}
      {directory.directories.map((child) => {
        const closed = collapsed.has(child.path)
        return (
          <Fragment key={child.path}>
            <button
              type="button"
              className={css.treeDirectory}
              style={{ '--tree-depth': depth } as CSSProperties}
              aria-expanded={!closed}
              onClick={() => {
                const next = new Set(collapsed)
                if (closed) next.delete(child.path)
                else next.add(child.path)
                setCollapsed(next)
              }}
            >
              {closed ? '▸' : '▾'} {child.name}
            </button>
            {closed ? null : renderDirectory(child, depth + 1, collapsed, setCollapsed, selected, onSelect)}
          </Fragment>
        )
      })}
    </>
  )
}
