// @vitest-environment jsdom
/**
 * Resolving a session's file link to the Workspace that scopes it: the mapping
 * behind `ctx.fileViewer`, and the path normalization every read then uses.
 *
 * The Workspace Controller is a stub here; the dialog's own behavior lives in
 * file-browser.client.spec.tsx and the assembled chain in
 * assembly.client.spec.tsx.
 */
import { describe, expect, it } from 'vitest'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { resolveViewPath, workspaceOfSession } from '../src/client/view-target.ts'

/** A Workspace row with only the fields the lookup reads. */
const workspace = (id: string, path: string, sessionIds: readonly string[]): WorkspaceView => ({
  workspaceId: id as never,
  path,
  title: id,
  sessionIds: sessionIds as never,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

/** A Workspace Controller whose snapshot is fixed. */
const controller = (items: readonly WorkspaceView[]): IWorkspaces =>
  ({ list: { getSnapshot: () => ({ items }) } }) as unknown as IWorkspaces

describe('workspaceOfSession', () => {
  it('finds the Workspace accounting for the session', () => {
    const workspaces = controller([
      workspace('w1', '/w/alpha', ['s1']),
      workspace('w2', '/w/beta', ['s2']),
    ])
    expect(workspaceOfSession(workspaces, 's2' as never)?.workspaceId).toBe('w2')
  })

  it('reports no Workspace for a session none accounts for', () => {
    const workspaces = controller([workspace('w1', '/w/alpha', ['s1'])])
    expect(workspaceOfSession(workspaces, 'orphan' as never)).toBeUndefined()
  })

  it('reports no Workspace when the registry is empty', () => {
    expect(workspaceOfSession(controller([]), 's1' as never)).toBeUndefined()
  })
})

describe('resolveViewPath', () => {
  const alpha = workspace('w1', '/w/alpha', ['s1'])

  it('keeps an already-relative path relative', () => {
    expect(resolveViewPath(alpha, 'src/main.ts')).toBe('src/main.ts')
  })

  it('leaves an absolute path outside the root untouched, even one starting like the root', () => {
    // `/src/main.ts` is absolute and outside `/w/alpha`; stripping the leading
    // separator would silently relocate the read onto a different file.
    expect(resolveViewPath(alpha, '/src/main.ts')).toBe('/src/main.ts')
  })

  it('makes an absolute path under the root workspace-relative', () => {
    expect(resolveViewPath(alpha, '/w/alpha/src/main.ts')).toBe('src/main.ts')
  })

  it('maps the root itself to the empty path', () => {
    expect(resolveViewPath(alpha, '/w/alpha')).toBe('')
  })

  it('leaves an absolute path outside the root untouched for the Host to refuse', () => {
    // Rewriting it here would only mask the containment refusal the read is
    // about to report.
    expect(resolveViewPath(alpha, '/etc/passwd')).toBe('/etc/passwd')
  })

  it('is not fooled by a sibling directory sharing the root prefix', () => {
    expect(resolveViewPath(alpha, '/w/alphabet/x.ts')).toBe('/w/alphabet/x.ts')
  })

  it('tolerates a trailing separator on the Workspace root', () => {
    const trailing = workspace('w1', '/w/alpha/', ['s1'])
    expect(resolveViewPath(trailing, '/w/alpha/src/main.ts')).toBe('src/main.ts')
  })
})
