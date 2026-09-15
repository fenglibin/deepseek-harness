// @vitest-environment jsdom
//
// The tree's one-row-per-line layout is a structural property, not a styling
// one: jsdom measures no layout, so what is asserted here is the shape that
// makes rows line up — every row a direct child of the container, which lays
// them out as flex items (one per line, stretched to the column's width).
// Wrapping a directory's rows in a block box would leave them in an inline
// flow, where a nested file's button sits beside the directory that holds it.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillFileNode } from '@deepseek-ai/dsh-api-remotes/client'
import { SkillFileTree } from '../src/client/SkillFileTree.tsx'

afterEach(cleanup)

/** One listed file. */
function file(path: string): SkillFileNode {
  return { path, bytes: path.length }
}

/** An entry whose tree holds root files, a directory, and a nested directory. */
const FILES: readonly SkillFileNode[] = [
  file('SKILL.md'),
  file('_meta.json'),
  file('scripts/find-sessions.sh'),
  file('scripts/wait-for-text.sh'),
  file('scripts/lib/helper.sh'),
]

/** Every row the tree rendered, in reading order. */
function rowsOf(container: HTMLElement): HTMLElement[] {
  const tree = container.firstElementChild
  if (tree === null) throw new Error('the tree rendered no container')
  return [...tree.children] as HTMLElement[]
}

/** The depth one row is indented to. */
function depthOf(row: HTMLElement): string {
  return row.style.getPropertyValue('--tree-depth')
}

/** Render the tree over {@link FILES} with the entry point selected. */
function renderTree(): HTMLElement {
  const { container } = render(
    <SkillFileTree files={FILES} selected="SKILL.md" onSelect={() => {}} truncated={false} />,
  )
  return container
}

describe('SkillFileTree rows', () => {
  it('keeps every row a direct child of the column, nesting included', () => {
    const rows = rowsOf(renderTree())

    // Flattened rather than nested: the container's flex column is what puts
    // one row on each line, so a per-directory wrapper would hand the rows back
    // to the inline flow and stack a file beside its directory.
    expect(rows.map(row => row.textContent)).toEqual([
      'SKILL.md',
      '_meta.json',
      '▾ scripts',
      'find-sessions.sh',
      'wait-for-text.sh',
      '▾ lib',
      'helper.sh',
    ])
    expect(rows.every(row => row.tagName === 'BUTTON')).toBe(true)
  })

  it('marks a nested row with its depth and its own directory with the parent depth', () => {
    const rows = rowsOf(renderTree())

    expect(rows.map(depthOf)).toEqual(['0', '0', '0', '1', '1', '1', '2'])
  })

  it('hides a closed directory\'s rows and restores the same shape when reopened', () => {
    const container = renderTree()
    const scripts = rowsOf(container)[2] as HTMLElement

    fireEvent.click(scripts)
    expect(rowsOf(container).map(row => row.textContent)).toEqual([
      'SKILL.md',
      '_meta.json',
      '▸ scripts',
    ])

    fireEvent.click(rowsOf(container)[2] as HTMLElement)
    expect(rowsOf(container).map(row => row.textContent)).toEqual([
      'SKILL.md',
      '_meta.json',
      '▾ scripts',
      'find-sessions.sh',
      'wait-for-text.sh',
      '▾ lib',
      'helper.sh',
    ])
  })

  it('selects a nested file by its path', () => {
    const selected: string[] = []
    const { container } = render(
      <SkillFileTree
        files={FILES}
        selected="SKILL.md"
        onSelect={(path) => { selected.push(path) }}
        truncated={false}
      />,
    )

    fireEvent.click(rowsOf(container)[4] as HTMLElement)

    expect(selected).toEqual(['scripts/wait-for-text.sh'])
  })

  it('reports a listing that stopped at a bound', () => {
    const { container } = render(
      <SkillFileTree files={FILES} selected="SKILL.md" onSelect={() => {}} truncated />,
    )

    expect(rowsOf(container).map(row => row.textContent)).toContain('…')
  })
})
