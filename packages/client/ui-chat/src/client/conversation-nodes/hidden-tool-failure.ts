import type { ChatConversationViewNode, ChatNode } from '../contract/chat-nodes.ts'
import { isSettledTool } from '../contract/chat-nodes.ts'

/**
 * Failure codes whose remedy belongs to the reader rather than to the model.
 *
 * The list is deliberately a whitelist: a code the reader can act on keeps its
 * row, and every other failure — including codes added by future tools, codes
 * from a replay of an older session, and failures carrying no `code` at all —
 * defaults to hidden. An unrecognized code is far more likely to be a
 * model-authored parameter error than something the reader must handle.
 */
const ACTIONABLE_CODES: ReadonlySet<string> = new Set([
  // The environment refused the operation; the reader may need to widen a policy.
  'FS_SANDBOX_DENIED',
  'FS_PERMISSION_DENIED',
  // An escalation needs approval the deployment cannot ask for: no approval
  // service is composed, the execution has no agent to route through, or the
  // session disabled prompts. Only the reader can resolve that configuration.
  'SANDBOX_APPROVAL_UNAVAILABLE',
  // The deployment has no usable provider, which no model retry can fix.
  'NO_PROVIDER',
  // The call needs an authority grant only the reader can give.
  'GOAL_TOOL_AUTHORITY_REQUIRED',
  // The search tooling itself is unavailable, not the model's query.
  'SEARCH_FAILED',
])

/**
 * Whether a materialized Chat node is a settled top-level tool call that failed
 * in a way the reader cannot act on.
 * @param node - the window's materialized Chat nodes, one at a time.
 * @returns true only for a settled root call whose failure the model owns.
 */
function isModelOwnedFailure(node: ChatConversationViewNode): boolean {
  const candidate = node as ChatNode
  if (candidate.kind !== 'tool-call') return false
  const root = candidate.data.root
  // Nested PTC sub-calls are not covered here: `tool/code-dispatch` records no
  // error identity, so a child's `ToolResultNode` has no `error` to read.
  if (!isSettledTool(root) || !root.isError) return false
  return !ACTIONABLE_CODES.has(root.error?.code ?? '')
}

/**
 * Projection that hides a tool failure the reader cannot act on: a bad
 * filesystem version, an out-of-range read offset, a search literal that does
 * not match, an unmet delivery-discipline precondition. In each case the
 * failing input is authored by the model, so correcting it is the model's own
 * next move; the reader has no part in the failure and no remedy for it. Only
 * the page is affected — the result the model receives is untouched, and it is
 * what the model corrects from.
 *
 * Hiding the unactionable majority unconditionally is what makes the rule hold
 * as tools grow: the reader-facing set stays small and explicit, while a new or
 * unknown failure code cannot turn into a stale row nobody can act on. A
 * failure whose code is absent hides too, because the failures that carry no
 * code are dominated by model-authored argument errors.
 *
 * The codes are read from the `tool/result` event's persisted
 * `error: { name, code }`, never parsed out of the result text: the same
 * condition is worded differently by each filesystem backend, so text
 * matching would be both brittle and incomplete.
 *
 * A visible failure row is not the only signal the reader keeps. A turn that
 * ends in failure renders its own terminal row, and an operation needing the
 * reader's consent asks through the approval surface instead of a result row —
 * so hiding the process rows does not hide the outcome or the question.
 *
 * This projection holds no state: its verdict is a property of one node alone.
 * It mirrors `ReferenceLabelProjector`'s replace/apply shape so it slots into
 * the Chat snapshot builder the same way.
 */
export class HiddenToolFailureProjector {
  /**
   * Mark every unactionable failure in a full window of nodes.
   * @param nodes - the window's materialized Chat nodes.
   * @returns the same nodes with unactionable failures marked hidden.
   */
  replace(nodes: readonly ChatConversationViewNode[]): ChatConversationViewNode[] {
    return nodes.map(node => this.hide(node))
  }

  /**
   * Mark an incremental upsert's unactionable failures. No stored node can
   * change visibility because the verdict never depends on a sibling.
   * @param upserts - the changed nodes.
   * @returns the changed nodes with unactionable failures marked hidden.
   */
  apply(upserts: readonly ChatConversationViewNode[]): ChatConversationViewNode[] {
    return upserts.map(node => this.hide(node))
  }

  /** Hide one node when it is an unactionable failure; pass every other node through. */
  private hide(node: ChatConversationViewNode): ChatConversationViewNode {
    return isModelOwnedFailure(node) ? { ...node, visibility: 'hidden' as const } : node
  }
}
