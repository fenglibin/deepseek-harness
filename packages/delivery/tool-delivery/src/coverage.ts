/**
 * Per-point coverage: extract the verification points an OpenSpec change
 * declares and check that the checklist covers each one. Points come from the
 * delta spec's own headings rather than `openspec show --json`, whose scenario
 * entries carry only raw text and no name to reference.
 * @module @deepseek-ai/dsh-tool-delivery/coverage
 */

/** One verification point: a spec scenario, a design decision, or a requirement. */
export interface CoveragePoint {
  /** Key a `covers:` annotation must use to declare this point. */
  readonly key: string
  /** Whether the point comes from a spec scenario, a design decision, or the request itself. */
  readonly source: 'scenario' | 'design' | 'requirement'
}

/** One checklist item with the points it declares. */
export interface CoverageItem {
  /** Item text without the trailing annotation. */
  readonly content: string
  /** Whether the item is marked complete. */
  readonly done: boolean
  /** Point keys declared by the item's `covers:` annotation. */
  readonly covers: readonly string[]
}

/** Gaps between the declared points and the annotated checklist. */
export interface CoverageReport {
  /** Point keys no item declares. */
  readonly uncovered: readonly string[]
  /** Item contents declaring a point outside the declared set. */
  readonly orphanItems: readonly string[]
  /** Item contents carrying no annotation at all. */
  readonly unanchoredItems: readonly string[]
}

/** `#### Scenario: <name>` inside a delta spec. */
const SCENARIO = /^#{3,5}\s*Scenario:\s*(.+?)\s*$/
/** `### D<n> …` design decision heading; the id is the `D<n>` token. */
const DESIGN = /^###\s+(\S+)/
/** Trailing `(covers: a, b)` annotation on one checklist line. */
const COVERS = /\((?:covers|覆盖)\s*:\s*([^)]*)\)\s*$/i
/** One markdown checkbox line. */
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/

/** Split one annotation body into trimmed, non-empty keys. */
function splitKeys(body: string): readonly string[] {
  return body.split(',').map(key => key.trim()).filter(key => key.length > 0)
}

/**
 * Extract scenario keys from one delta spec body.
 * @param capability - capability directory the spec lives in.
 * @param text - spec.md body.
 * @returns one point per `#### Scenario:` heading, keyed `<capability>/<name>`.
 */
export function scenarioPoints(capability: string, text: string): readonly CoveragePoint[] {
  const points: CoveragePoint[] = []
  for (const line of text.split('\n')) {
    const match = SCENARIO.exec(line)
    if (match?.[1] === undefined) continue
    points.push({ key: `${capability}/${match[1]}`, source: 'scenario' })
  }
  return points
}

/**
 * Extract design decision keys from one design.md body.
 * @param text - design.md body.
 * @returns one point per `### D<n>` decision heading, keyed `design/D<n>`.
 */
export function designPoints(text: string): readonly CoveragePoint[] {
  const points: CoveragePoint[] = []
  for (const line of text.split('\n')) {
    const match = DESIGN.exec(line)
    if (match?.[1] === undefined) continue
    points.push({ key: `design/${match[1]}`, source: 'design' })
  }
  return points
}

/** A numbered requirement item, as a request usually lists its demands. */
const REQUEST_ITEM = /^\s*(\d{1,2})\s*[、.．)）]\s*(.+?)\s*$/

/**
 * Extract the individual demands of the original request.
 *
 * A request written as a numbered list states each demand as its own point;
 * verification has to confirm every one of them, which a single free-text
 * confirmation cannot do. A request with no numbered list yields no points, so
 * callers fall back to the checklist and design coverage they already have
 * rather than reporting the whole request as one uncovered point.
 * @param objective - the original request text.
 * @returns one point per numbered item, keyed `req/<n>`.
 */
export function requirementPoints(objective: string): readonly CoveragePoint[] {
  const points: CoveragePoint[] = []
  for (const line of objective.split('\n')) {
    const match = REQUEST_ITEM.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    if (match[2].trim().length === 0) continue
    points.push({ key: `req/${match[1]}`, source: 'requirement' })
  }
  return points
}

/**
 * The point keys one checklist item content declares.
 * @param content - item text, with or without a trailing annotation.
 * @returns declared keys; empty when the item carries no annotation.
 */
export function coversOf(content: string): readonly string[] {
  const annotation = COVERS.exec(content.trim())
  return annotation?.[1] === undefined ? [] : splitKeys(annotation[1])
}

/**
 * Parse one tasks.md body into annotated checklist items.
 * @param text - tasks.md body.
 * @returns one entry per checkbox line, with its declared point keys.
 */
export function parseChecklist(text: string): readonly CoverageItem[] {
  const items: CoverageItem[] = []
  for (const line of text.split('\n')) {
    const match = CHECKBOX.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const done = match[1].toLowerCase() === 'x'
    const body = match[2].trim()
    const annotation = COVERS.exec(body)
    const content = annotation === null ? body : body.slice(0, annotation.index).trim()
    const covers = annotation?.[1] === undefined ? [] : splitKeys(annotation[1])
    items.push({ content, done, covers })
  }
  return items
}

/**
 * Compare the declared points against the annotated checklist.
 * @param points - verification points the change declares.
 * @param items - checklist items carrying their `covers:` annotations.
 * @returns uncovered points, items anchored to unknown points, and items
 * carrying no annotation.
 */
export function coverageReport(
  points: readonly CoveragePoint[],
  items: readonly CoverageItem[],
): CoverageReport {
  const declared = new Set(points.map(point => point.key))
  const covered = new Set<string>()
  const orphanItems: string[] = []
  const unanchoredItems: string[] = []
  for (const item of items) {
    // An item without an annotation and one pointing at an unknown key are
    // different failures, so each item lands in exactly one of them.
    if (item.covers.length === 0) {
      unanchoredItems.push(item.content)
      continue
    }
    for (const key of item.covers) {
      if (!declared.has(key)) orphanItems.push(`${item.content} → ${key}`)
      else covered.add(key)
    }
  }
  const uncovered = points.map(point => point.key).filter(key => !covered.has(key))
  return { uncovered, orphanItems, unanchoredItems }
}

/** Whether a report has any gap to report. */
export function hasCoverageGap(report: CoverageReport): boolean {
  return report.uncovered.length > 0
    || report.orphanItems.length > 0
    || report.unanchoredItems.length > 0
}

/** Render a report as one line per gap, for the model to act on. */
export function describeCoverageGap(report: CoverageReport): string {
  const lines: string[] = []
  if (report.uncovered.length > 0) lines.push(`uncovered points: ${report.uncovered.join(', ')}`)
  if (report.orphanItems.length > 0) lines.push(`items citing unknown points: ${report.orphanItems.join(', ')}`)
  if (report.unanchoredItems.length > 0) lines.push(`items without a covers annotation: ${report.unanchoredItems.join(', ')}`)
  return lines.join('; ')
}
