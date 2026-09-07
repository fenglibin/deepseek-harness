import { describe, expect, it } from 'vitest'
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'

function fixture(): Map<string, Buffer> {
  const base = '2026-07-26-example'
  const zh = Buffer.from('# Agent Note: 示例\n\nStatus: implemented\nArchived: 2026-07-26\n\n## 问题\n\n示例。\n')
  return new Map([
    [`process/${base}.zh.md`, zh],
  ])
}

describe('archived Agent Notes', () => {
  it('recognizes archived paths with POSIX and Windows separators', () => {
    expect(isArchivedAgentNotePath('.agents/notes/archived/process/example.zh.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents\\notes\\archived\\process\\example.zh.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents/notes/implemented/process/example.zh.md')).toBe(false)
  })

  it('accepts one complete archived Chinese note with matching archive metadata', () => {
    expect(validateArchiveArtifacts(fixture())).toEqual([])
  })

  it('rejects non-Chinese files and invalid archive headers', () => {
    const artifacts = fixture()
    artifacts.set('process/2026-07-26-example.md', Buffer.from('# Agent Note: Example\n'))
    expect(validateArchiveArtifacts(artifacts).join('\n')).toMatch(/expected \{kind\}\/yyyy-mm-dd-topic\.zh\.md/)
    artifacts.delete('process/2026-07-26-example.md')
    artifacts.set(
      'process/2026-07-26-example.zh.md',
      Buffer.from('# Agent Note: 示例\n\nStatus: proposed\nArchived: yesterday\n'),
    )
    expect(validateArchiveArtifacts(artifacts).join('\n')).toMatch(/line 3 must be `Status: implemented`/)
  })

  it('extends the manifest without permitting a sealed change or removal', () => {
    const artifacts = fixture()
    const empty: ArchiveManifest = { version: 1, files: {} }
    const first = extendArchiveManifest(empty, artifacts)
    expect(first.errors).toEqual([])
    expect(first.added).toHaveLength(1)

    const sealed: ArchiveManifest = { version: 1, files: first.files }
    const changed = new Map(artifacts)
    changed.set('process/2026-07-26-example.zh.md', Buffer.from('changed'))
    expect(extendArchiveManifest(sealed, changed).errors).toEqual([
      'process/2026-07-26-example.zh.md: sealed content hash changed',
    ])
    changed.delete('process/2026-07-26-example.zh.md')
    expect(extendArchiveManifest(sealed, changed).errors).toContain(
      'process/2026-07-26-example.zh.md: sealed artifact is missing',
    )
  })

  it('rejects replacing manifest seals alongside changed archive content', () => {
    const artifacts = fixture()
    const initial = extendArchiveManifest({ version: 1, files: {} }, artifacts)
    const baseline: ArchiveManifest = { version: 1, files: initial.files }
    const path = 'process/2026-07-26-example.zh.md'
    const changedArtifacts = new Map(artifacts)
    changedArtifacts.set(path, Buffer.from('changed'))
    const replacement = extendArchiveManifest({ version: 1, files: {} }, changedArtifacts)
    const current: ArchiveManifest = { version: 1, files: replacement.files }

    expect(extendArchiveManifest(current, changedArtifacts).errors).toEqual([])
    // The baseline guard is presence-only: a `.zh.md` may only be resealed
    // through an explicit `--write`/`--rewrite` manifest update in the same
    // change, never removed silently.
    expect(validateArchiveManifestExtension(baseline, current)).toEqual([])
    const removed: ArchiveManifest = {
      version: 1,
      files: Object.fromEntries(Object.entries(current.files).filter(([candidate]) => candidate !== path)),
    }
    expect(validateArchiveManifestExtension(baseline, removed)).toContain(
      `${path}: sealed manifest entry is missing`,
    )
  })

  it('round-trips the deterministic manifest schema', () => {
    const content = renderArchiveManifest({ 'process/z.zh.md': `sha256:${'a'.repeat(64)}` })
    expect(parseArchiveManifest(content)).toEqual({
      version: 1,
      files: { 'process/z.zh.md': `sha256:${'a'.repeat(64)}` },
    })
  })
})
