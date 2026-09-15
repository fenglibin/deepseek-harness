import type { ChatConversationViewNode, ChatNode } from '../contract/chat-nodes.ts'
import { isSettledTool } from '../contract/chat-nodes.ts'

/** Failure codes whose cause is the model's own search text, not the reader's environment. */
const HIDDEN_CODES: ReadonlySet<string> = new Set(['FS_EDIT_NOT_FOUND', 'FS_AMBIGUOUS_EDIT'])

/**
 * Whether a materialized Chat node is a settled top-level tool call that
 * failed with one of {@link HIDDEN_CODES}.
 * @param node - the window's materialized Chat nodes, one at a time.
 * @returns true only for a settled root call carrying a hidden failure code.
 */
function isHiddenFailure(node: ChatConversationViewNode): boolean {
  const candidate = node as ChatNode
  if (candidate.kind !== 'tool-call') return false
  const root = candidate.data.root
  // Nested PTC sub-calls are not covered here: `tool/code-dispatch` records no
  // error identity, so a child's `ToolResultNode` has no `error` to read.
  if (!isSettledTool(root) || !root.isError) return false
  return HIDDEN_CODES.has(root.error?.code ?? '')
}

/**
 * Projection that hides a tool failure the user cannot act on: a literal edit
 * whose search text was wrong. `old_string` / `old_str` is authored by the
 * model, so rewriting it, widening it, or switching to `replace_all` is the
 * model's own next move; the reader has no part in the failure and no remedy
 * for it. Only the page is affected — the result the model receives is
 * untouched, and it is what the model corrects from.
 *
 * The codes are read from the `tool/result` event's persisted
 * `error: { name, code }`, never parsed out of the result text: the same
 * condition is worded differently by each filesystem backend, so text
 * matching would be both brittle and incomplete.
 *
 * This is separate from `RecoveredMutationProjector` rather than an addition
 * to its code set. That projection hides a failure *conditionally* — only once
 * a later mutation of the same path succeeded — while a wrong search text is
 * hidden *unconditionally*: the model often abandons the path instead of
 * retrying, and that is exactly the stale row the reader sees today. Its codes
 * therefore must not enter that projection's set, where `FS_EDIT_NOT_FOUND`
 * would stay visible whenever no retry followed.
 *
 * It mirrors `ReferenceLabelProjector`'s replace/apply shape so it slots into
 * the Chat snapshot builder the same way; unlike the recovered-mutation
 * projection it holds no state, because its verdict is a property of one node
 * alone.
 */
export class HiddenToolFailureProjector {
  /**
   * Mark every unactionable failure in a full window of nodes.
   * @param nodes - the window's materialized Chat nodes.
   * @returns the same nodes with hidden failures marked hidden.
   */
  replace(nodes: readonly ChatConversationViewNode[]): ChatConversationViewNode[] {
    return nodes.map(node => this.hide(node))
  }

  /**
   * Mark an incremental upsert's unactionable failures. No stored node can
   * change visibility because the verdict never depends on a sibling.
   * @param upserts - the changed nodes.
   * @returns the changed nodes with hidden failures marked hidden.
   */
  apply(upserts: readonly ChatConversationViewNode[]): ChatConversationViewNode[] {
    return upserts.map(node => this.hide(node))
  }

  /** Hide one node when it is an unactionable failure; pass every other node through. */
  private hide(node: ChatConversationViewNode): ChatConversationViewNode {
    return isHiddenFailure(node) ? { ...node, visibility: 'hidden' as const } : node
  }
}
