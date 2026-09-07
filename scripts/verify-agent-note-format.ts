/**
 * Enforce Agent Note headers, lifecycle-specific sections, alternatives, and retired
 * marker rules. Classification and filenames belong to the sibling tree gate;
 * format and grandfathering rules live in `.agents/notes/README.zh.md`.
 *
 * Agent Notes are Chinese-only prose whose section titles are accepted in
 * either English or Chinese. Each canonical section role maps to the set of
 * spellings the corpus actually uses, so a note that says `## 决策` satisfies
 * the same rule as one that says `## Decision`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentNoteRoot, walkAgentNoteTree } from './agent-note-tree.ts'

/** The date these format rules took effect; the grandfather comment is valid only before it. */
const FORMAT_ADOPTED = '2026-07-05'

/** The exact comment a pre-format Agent Note carries in place of an alternatives section. */
const GRANDFATHER = '<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->'

/** The retired debt marker that flagged pre-format bodies; banned so it cannot creep back. */
const LEGACY_MARKERS = ['XXX: legacy ADR/RFC body format', 'XXX: legacy ADR/Agent Note body format']

/** Status-line grammar per lifecycle folder. */
const STATUS: Record<string, RegExp> = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
}

/**
 * A section heading spelling: an exact title, or a prefix when a heading
 * carries a qualifier after the canonical name (e.g. `## Decision（框架五条）`).
 */
interface HeadingSpelling {
  /** Literal heading text that must match exactly (or be a prefix). */
  heading: string
  /** When true, any `## ` heading starting with `heading` matches. */
  prefix?: boolean
}

/** A section heading is spelled `## <title>`; this helper builds the spelling. */
function spelling(title: string): HeadingSpelling {
  return { heading: `## ${title}` }
}

/** A prefix spelling matches `## Decision（框架五条）` as well as `## Decision`. */
function prefixSpelling(title: string): HeadingSpelling {
  return { heading: `## ${title}`, prefix: true }
}

function headingMatches(h2: string, candidate: HeadingSpelling): boolean {
  return candidate.prefix === true ? h2.startsWith(candidate.heading) : h2 === candidate.heading
}

function anyHeadingMatches(h2: string, candidates: readonly HeadingSpelling[]): boolean {
  return candidates.some(candidate => headingMatches(h2, candidate))
}

/**
 * The first body section of every Agent Note states the problem; the corpus
 * writes it as `## Problem` or `## 问题`.
 */
const PROBLEM: readonly HeadingSpelling[] = [spelling('Problem'), spelling('问题')]

/**
 * Section roles that a lifecycle requires, each named by every spelling the
 * corpus uses. A role is satisfied when any of its spellings appears.
 */
const SECTION_ROLES: Record<string, HeadingSpelling[][]> = {
  proposed: [
    [spelling('Proposal'), spelling('提案'), spelling('提议'), spelling('方案')],
    [spelling('Acceptance criteria'), spelling('验收标准'), spelling('接受标准')],
    [spelling('Risks'), spelling('风险')],
  ],
  implemented: [
    [prefixSpelling('Decision'), spelling('决策'), spelling('决定')],
    // `## 影响` / `## 结果` are the Chinese consequences spellings the early
    // Chinese notes used before `## 后果` became the canonical translation.
    [spelling('Consequences'), spelling('后果'), spelling('影响'), spelling('结果')],
  ],
  rejected: [
    [spelling('Proposal'), spelling('提案'), spelling('提议'), spelling('方案')],
  ],
}

/**
 * The alternatives section, in every spelling the corpus uses. A pre-format
 * note whose alternatives are not reconstructible carries the grandfather
 * comment instead.
 */
const ALTERNATIVES: readonly HeadingSpelling[] = [
  spelling('Alternatives considered'),
  spelling('曾考虑的替代方案'),
  spelling('考虑过的替代方案'),
  spelling('考虑过的备选方案'),
  spelling('考虑过的备选'),
  spelling('已考虑的替代方案'),
  spelling('已考虑并否决的替代方案'),
  spelling('被否决的方案'),
  spelling('被否决的替代方案'),
  spelling('拒绝的方案'),
  spelling('权衡的替代方案'),
  spelling('备选方案'),
  spelling('替代方案'),
]

/**
 * Proposal-era headings banned in `implemented/` — spec-speak that states what
 * should be instead of what is. Both the English spellings and their Chinese
 * counterparts are banned.
 */
const BANNED_IMPLEMENTED: RegExp[] = [
  /^## (?:Proposal|Plan|Migration plan)\b/i,
  /^## (?:提案|计划|迁移计划)\b/,
  /^## (?:Acceptance criteria)\b/i,
  /^## 验收标准\b/,
]

const { notes, errors } = walkAgentNoteTree()

for (const note of notes) {
  const fail = (msg: string): void => {
    errors.push(`format: ${note.rel} — ${msg}`)
  }
  const lines = readFileSync(resolve(agentNoteRoot, note.rel), 'utf8').split('\n')
  // Format tokens inside fenced examples are not document structure.
  let inFence = false
  const prose = lines.filter((l) => {
    if (l.startsWith('```')) {
      inFence = !inFence
      return false
    }
    return !inFence
  })

  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) fail('line 1 must be `# Agent Note: <title>`')
  if (lines[1] !== '') fail('line 2 must be blank')
  const status = STATUS[note.lifecycle]
  if (status !== undefined && !status.test(lines[2] ?? '')) {
    fail(`line 3 must match the ${note.lifecycle} status grammar (${String(status)})`)
  }
  if (lines[3] !== '') fail('line 4 must be blank')
  const statusLines = prose.filter(l => l.startsWith('Status:') && l !== lines[2])
  if (statusLines.length > 0 || prose.filter(l => l === lines[2]).length > 1) {
    fail('the line-3 `Status:` line must be the only one in the file')
  }

  const h2s = prose.filter(l => l.startsWith('## ')).map(l => l.trimEnd())
  if (!anyHeadingMatches(h2s[0] ?? '', PROBLEM)) {
    fail(`the first section must be \`## Problem\` or \`## 问题\` (got ${JSON.stringify(h2s[0] ?? '<none>')})`)
  }
  for (const role of SECTION_ROLES[note.lifecycle] ?? []) {
    if (!h2s.some(h2 => anyHeadingMatches(h2, role))) {
      fail(`missing a required ${role.map(s => `\`${s.heading}\``).join(' / ')} section`)
    }
  }
  if (note.lifecycle === 'implemented') {
    for (const h2 of h2s) {
      if (BANNED_IMPLEMENTED.some(re => re.test(h2))) {
        fail(`\`${h2}\` is a proposal-era heading; an implemented Agent Note states what is (fold it into Decision/Consequences/Testing)`)
      }
    }
  }

  const hasSection = h2s.some(h2 => anyHeadingMatches(h2, ALTERNATIVES))
  const hasGrandfather = prose.includes(GRANDFATHER)
  if (hasSection && hasGrandfather) fail('carries both an alternatives section and the grandfather comment — drop the comment')
  if (!hasSection && !hasGrandfather) fail('missing an alternatives section (a pre-format Agent Note whose alternatives are not reconstructible carries the grandfather comment instead — see .agents/notes/README.zh.md § The file format)')
  if (hasGrandfather && note.date >= FORMAT_ADOPTED) fail(`the grandfather comment is only valid for Agent Notes dated before ${FORMAT_ADOPTED}`)

  if (prose.some(line => LEGACY_MARKERS.some(marker => line.includes(marker)))) fail('carries the retired legacy-format debt marker')
}

if (errors.length === 0) {
  console.log(`verify-agent-note-format: ${notes.length} Agent Note(s) checked, all conform to .agents/notes/README.zh.md § The file format.`)
  process.exit(0)
}

console.error('verify-agent-note-format: violations found:')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
