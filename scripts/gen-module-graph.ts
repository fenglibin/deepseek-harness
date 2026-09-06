/** Generate the paired shared-instance package graph from workspace peer dependencies. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  collectPackageGraph,
  escapeMermaidLabel as escLabel,
  graphNodeId as nodeId,
  type PackageGraphNode,
} from './package-graph.ts'
const root = resolve(import.meta.dirname, '..')
const SOURCE = 'docs/module-graph.zh.md'
type Pkg = PackageGraphNode

const GROUP_ORDER = [
  'util',
  'llm',
  'core',
  'goal',
  'bash',
  'fs',
  'skill',
  'compact',
  'subagent',
  'web',
  'spill',
  'timeout',
  'todo',
  'plan',
  'cordis',
  'hooks',
  'session-persistence',
  'session-query',
  'session-title',
  'support',
  'acp',
  'ui',
]

function packageLink(pkg: Pkg): string {
  return `[\`${pkg.short}\`](../${pkg.rel})`
}

/**
 * Render one locale of the complete deterministic package graph.
 * @param pkgs - Dependency-first package nodes.
 * @returns Complete generated Markdown.
 */
export function renderModuleGraph(pkgs: readonly Pkg[]): string {
  const edges: string[] = []
  for (const pkg of pkgs) {
    for (const dependency of pkg.deps) edges.push(`  ${nodeId('pkg', pkg.short)} --> ${nodeId('pkg', dependency)}`)
  }
  const byShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  const groups = [...new Set(pkgs.map(pkg => pkg.group))].sort((left, right) => {
    const leftIndex = GROUP_ORDER.indexOf(left)
    const rightIndex = GROUP_ORDER.indexOf(right)
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex
    return normalizedLeft - normalizedRight || left.localeCompare(right)
  })
  const groupBlocks: string[] = []
  for (const group of groups) {
    groupBlocks.push(`  subgraph ${nodeId('group', group)}["packages/${escLabel(group)}"]`)
    for (const pkg of pkgs.filter(candidate => candidate.group === group)
      .sort((left, right) => left.short.localeCompare(right.short))) {
      groupBlocks.push(`    ${nodeId('pkg', pkg.short)}["${escLabel(pkg.short)}"]`)
    }
    groupBlocks.push('  end')
  }
  const rows = pkgs.map((pkg) => {
    const dependencies = pkg.deps.length > 0
      ? pkg.deps.map((dependency) => {
        const target = byShort.get(dependency)
        return target ? packageLink(target) : `\`${dependency}\``
      }).join(', ')
      : '—'
    return `| ${packageLink(pkg)} | \`${pkg.group}\` | ${dependencies} |`
  })
  return [
    '<!-- 由 scripts/gen-module-graph.ts 生成——请勿手工编辑。\n     运行 `pnpm run gen-module-graph` 重新生成。 -->',
    '',
    '# 共享实例依赖关系图',
    '',
    '`@deepseek-ai/dsh-*` harness 包之间的 peer 依赖关系。peer 表示消费端需要提供共享实例，不包括普通运行时 dependency 或仅开发期关系。该图按 `packages/<group>/<pkg>` 层级分组；边 `a --> b` 表示包 `a` peer 依赖包 `b`。名称中的 `@deepseek-ai/dsh-` 前缀已移除。',
    '',
    '```mermaid',
    'flowchart TD',
    ...groupBlocks,
    ...edges,
    '```',
    '',
    '| 包 | 分组 | Peer 依赖 |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

/**
 * Compute the Chinese graph document from the current workspace manifests.
 * @param scanRoot - Repository root containing packages and documentation.
 * @returns Repository-relative output paths and exact generated content.
 */
export function computeModuleGraphOutputs(scanRoot: string = root): ReadonlyMap<string, string> {
  const packages = collectPackageGraph(scanRoot, GROUP_ORDER, 'gen-module-graph')
  return new Map([
    [SOURCE, renderModuleGraph(packages)],
  ])
}

/**
 * Write the Chinese graph document.
 * @param scanRoot - Repository root containing packages and documentation.
 * @returns Repository-relative paths whose content changed.
 */
export function writeModuleGraph(scanRoot: string = root): string[] {
  const outputs = computeModuleGraphOutputs(scanRoot)
  const changed: string[] = []
  for (const [path, content] of outputs) {
    const destination = resolve(scanRoot, path)
    if (existsSync(destination) && readFileSync(destination, 'utf8') === content) continue
    writeFileSync(destination, content)
    changed.push(path)
  }
  return changed.sort()
}

/** CLI entry: regenerate by default, or verify all paired outputs with `--check`. @returns Nothing. */
export function main(): void {
  const expected = computeModuleGraphOutputs(root)
  if (process.argv.includes('--check')) {
    const stale = [...expected].filter(([path, content]) => (
      !existsSync(resolve(root, path)) || readFileSync(resolve(root, path), 'utf8') !== content
    )).map(([path]) => path)
    if (stale.length === 0) {
      console.log(`gen-module-graph: ${expected.size} artifact(s) are up to date.`)
      return
    }
    console.error(`gen-module-graph: stale — ${stale.join(', ')}. Run \`pnpm run gen-module-graph\` and commit the result.`)
    process.exitCode = 1
    return
  }
  const changed = writeModuleGraph(root)
  console.log(`gen-module-graph: ${expected.size} artifact(s) computed, ${String(changed.length)} written.`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) main()
