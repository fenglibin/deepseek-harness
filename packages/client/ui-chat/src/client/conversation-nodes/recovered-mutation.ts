import type { ChatConversationViewNode, ChatNode, ToolChatData } from '../contract/chat-nodes.ts'
import { isSettledTool } from '../contract/chat-nodes.ts'

/**
 * Projection that hides a recovered filesystem-mutation failure: a guarded
 * `edit` / `write` / `str_replace_editor` call that failed with a recoverable
 * code (`FS_NOT_OBSERVED` / `FS_STALE_VERSION`) and was followed — same file,
 * later anchor — by a successful mutation of the same path. The failure is
 * transient by contract: its own remedy is "read the file, then retry", so
 * once a later call succeeded, the page must not keep the stale error row.
 *
 * The model-retry projection (retry.ts) hides a recovered request retry chain
 * by the owning turn's terminal outcome; this projection is the tool-call
 * analogue: it hides a recovered mutation call by a later successful mutation
 * of the same path. Both mark `visibility: 'hidden'`, never `null`, because a
 * live turn materializes the row first and the assembler forbids withdrawing a
 * materialized node.
 */

/** Guarded-mutation failure codes whose remedy is a re-read then retry. */
const RECOVERABLE_CODES: ReadonlySet<string> = new Set(['FS_NOT_OBSERVED', 'FS_STALE_VERSION'])

/** First-party mutation tools whose settled calls this projection inspects. */
const MUTATION_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'str_replace_editor'])

/**
 * Extract the mutation path from a mutation tool's raw arguments. The path
 * key matches `ui-deliverables`'s `mutationPath` vocabulary so the two folds
 * agree on which calls name the same file; only the field read differs by
 * tool (`file_path` for `edit`/`write`, `path` for `str_replace_editor`).
 * @param name - wire tool name.
 * @param argsRaw - model-produced JSON arguments.
 * @returns the path, or null when the call is not a mutation with a usable path.
 */
function mutationPath(name: string, argsRaw: string): string | null {
  if (!MUTATION_TOOLS.has(name)) return null
  let args: unknown
  try {
    args = JSON.parse(argsRaw) as unknown
  } catch {
    return null
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const record = args as Record<string, unknown>
  const path = name === 'str_replace_editor' ? record.path : record.file_path
  return typeof path === 'string' && path.trim() !== '' ? path : null
}

/** One mutation call's projection facts, derived from a settled tool-call node. */
interface MutationInfo {
  readonly key: string
  readonly path: string
  readonly anchorSeq: number
  readonly isSuccess: boolean
  readonly isRecoverableFailure: boolean
}

/**
 * Derive projection facts from a tool-call node, or null when the node is not
 * a settled root mutation (running calls, non-mutation tools, missing call
 * heads, and unreadable paths all fall through untouched).
 * @param node - materialized Chat node.
 * @returns the mutation facts, or null for any non-mutation node.
 */
function mutationInfo(node: ChatConversationViewNode): MutationInfo | null {
  const candidate = node as ChatNode
  if (candidate.kind !== 'tool-call') return null
  const root = (candidate.data as ToolChatData).root
  if (!isSettledTool(root)) return null
  const call = root.call
  if (call === null) return null
  const path = mutationPath(call.name, call.argsRaw)
  if (path === null) return null
  return {
    key: node.key,
    path,
    anchorSeq: node.anchorSeq,
    isSuccess: !root.isError,
    isRecoverableFailure: root.isError && RECOVERABLE_CODES.has(root.error?.code ?? ''),
  }
}

/** A failed mutation is covered once a later successful mutation shares its path. */
function isCovered(latestSuccessSeq: ReadonlyMap<string, number>, path: string, anchorSeq: number): boolean {
  const latest = latestSuccessSeq.get(path)
  return latest !== undefined && latest > anchorSeq
}

/**
 * Projection that folds recovered mutation failures out of the rendered order.
 * It mirrors `ReferenceLabelProjector`'s replace/apply shape so it slots into
 * the Chat snapshot builder the same way: `replace` rebuilds over the whole
 * window, `apply` updates incrementally and re-hides earlier failures when a
 * later success lands.
 */
export class RecoveredMutationProjector {
  /** Per-path latest successful mutation anchor, the coverage threshold. */
  private readonly latestSuccessSeq = new Map<string, number>()

  /** Per-path keys of recoverable-failure mutations still needing re-evaluation. */
  private readonly failedKeysByPath = new Map<string, Set<string>>()

  /**
   * Rebuild the projection over a full window of nodes.
   * @param nodes - the window's materialized Chat nodes.
   * @returns the same nodes with recovered failures marked hidden.
   */
  replace(nodes: readonly ChatConversationViewNode[]): ChatConversationViewNode[] {
    this.latestSuccessSeq.clear()
    this.failedKeysByPath.clear()
    for (const node of nodes) {
      const info = mutationInfo(node)
      if (info?.isSuccess) {
        const previous = this.latestSuccessSeq.get(info.path)
        if (previous === undefined || info.anchorSeq > previous) {
          this.latestSuccessSeq.set(info.path, info.anchorSeq)
        }
      }
    }
    return nodes.map(node => this.cover(node, mutationInfo(node)))
  }

  /**
   * Update the projection for an incremental upsert, re-hiding any earlier
   * failure a newly landed success now covers.
   * @param upserts - the changed nodes.
   * @param store - current node store (pre-upsert state).
   * @returns the changed nodes plus any store nodes whose visibility changed.
   */
  apply(
    upserts: readonly ChatConversationViewNode[],
    store: { get(key: string): ChatConversationViewNode | undefined },
  ): ChatConversationViewNode[] {
    const result = new Map<string, ChatConversationViewNode>()
    const newlySucceededPaths = new Set<string>()

    for (const node of upserts) {
      const info = mutationInfo(node)
      if (info === null) {
        result.set(node.key, node)
        continue
      }
      if (info.isSuccess) {
        const previous = this.latestSuccessSeq.get(info.path)
        if (previous === undefined || info.anchorSeq > previous) {
          this.latestSuccessSeq.set(info.path, info.anchorSeq)
          newlySucceededPaths.add(info.path)
        }
        result.set(node.key, node)
        continue
      }
      result.set(node.key, this.cover(node, info))
    }

    for (const path of newlySucceededPaths) {
      const keys = this.failedKeysByPath.get(path)
      if (keys === undefined) continue
      for (const key of keys) {
        const existing = result.get(key) ?? store.get(key)
        if (existing === undefined) continue
        const info = mutationInfo(existing)
        if (info !== null && info.isRecoverableFailure) {
          result.set(key, this.cover(existing, info))
        }
      }
    }

    return [...result.values()]
  }

  /**
   * Register a recoverable failure so a later success can re-hide it, then
   * hide it immediately when a later success already exists. Every other node
   * passes through unchanged.
   */
  private cover(node: ChatConversationViewNode, info: MutationInfo | null): ChatConversationViewNode {
    if (info?.isRecoverableFailure) {
      const keys = this.failedKeysByPath.get(info.path) ?? new Set<string>()
      keys.add(info.key)
      this.failedKeysByPath.set(info.path, keys)
      if (isCovered(this.latestSuccessSeq, info.path, info.anchorSeq)) {
        return { ...node, visibility: 'hidden' as const }
      }
    }
    return node
  }
}
