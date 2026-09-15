/**
 * Scope mapping for the skills Settings section.
 *
 * Discovery labels every root it scans with the source contributing it; this
 * module groups those sources into the three panes a reader navigates. The
 * mapping lives here because "which pane does this source belong to" is a
 * presentation decision, while the source label is the discovery contract — a
 * Host field would make the two planes' vocabularies drift.
 */

import type { SkillRootView } from '@deepseek-ai/dsh-api-remotes/client'

/** One scope pane the section navigates. */
export type SkillScope = 'global' | 'app' | 'workspace'

/** Panes in navigation order. */
export const SKILL_SCOPES: readonly SkillScope[] = ['global', 'app', 'workspace']

/**
 * Sources each pane shows. A source absent from every list (a deployment's
 * `custom` roots, its read-only `bundled` root, any provider-specific label)
 * has no pane, and its entries stay off this page rather than landing in a
 * pane whose scope they do not share.
 */
const SOURCES: Record<SkillScope, readonly string[]> = {
  global: ['user-agents'],
  app: ['user-dsh'],
  workspace: ['project-dsh', 'project-agents'],
}

/** Every root one pane shows, in the precedence order the Host returned. */
export function rootsInScope(roots: readonly SkillRootView[], scope: SkillScope): readonly SkillRootView[] {
  return roots.filter(root => SOURCES[scope].includes(root.source))
}
