/**
 * Pure types of the session-file-revisions domain: one session's captured file
 * baselines and end-states, and the results a revert reports.
 *
 * A **baseline** is the file's content when this session (or one of its
 * descendant subagent sessions) first mutated it; it is null unless the first
 * mutation found existing content (see {@link BaselineOrigin}). An **end-state**
 * is the content after this session's last mutation. The pair bounds what this
 * session did, which is what both the displayed diff and the revert act on.
 *
 * @module @deepseek-ai/dsh-session-file-revisions/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 本会话中首次触碰某路径的改动类型。 */
export type RevisionOperation = 'write' | 'edit' | 'delete'

/**
 * What this session's first mutation found at the path.
 *
 * `existing` carries the file's prior content as the baseline. `absent` means
 * the file really was not there, so a revert removes it. `unknown` means the
 * mutation overwrote a file whose prior content was never captured — the
 * storage backend reports a null `before` for an overwrite at or above its
 * presentation bound, and for binary, non-UTF-8, or unreadable content. A
 * revert cannot reconstruct a baseline it never had, so `unknown` is reported
 * as a conflict rather than guessed at.
 *
 * `deleted` 表示观察该会话改动时该路径已不在会话工作区内，且没有任何工具调用
 * 携带过它的内容——是 shell 命令删掉了它。这条记录不持有任何内容侧，因为发现
 * 删除时那里已经没有东西可读；恢复改从工作区的 git 对象取内容。
 */
export type BaselineOrigin = 'existing' | 'absent' | 'unknown' | 'deleted'

/**
 * Comparable position of one mutation in the whole delegation tree.
 *
 * A session's own `seq` counts its own log, so a subagent's seq and its
 * parent's seq measure different things — a child forked from a parent log of
 * length L starts its own seq at L. Merging parent and child records on raw seq
 * can therefore take a child's baseline as the earlier side of a parent's later
 * mutation, which loses the path's whole session change. Inside one session seq
 * stays authoritative (it is what makes folding independent of arrival order);
 * across sessions the settle instant is the only ordering both logs share.
 */
export interface RevisionOrder {
  /** The session that settled the mutation. */
  readonly session: SessionId
  /** Wall-clock instant the mutation settled, in Unix epoch milliseconds. */
  readonly at: number
  /** Seq within the mutating session's own log. */
  readonly seq: number
}

/**
 * One path's captured revision facts.
 *
 * `baseline` 持有本次会话首次改动前该文件的内容，只要
 * {@link FileRevision.origin} 不是 `existing` 就为 null。`origin` 与 `baseline`
 * 这一对是撤销的判据：只有 `absent` 可以删除文件，只有 `existing` 可以做反向
 * 补丁，而 `deleted` 因为自身不携带内容，改从工作区的 git 对象恢复。
 */
export interface FileRevision {
  /** Canonical absolute path; the same spelling the changed-files fold uses. */
  readonly path: string
  /** Content before this session's first mutation; null unless `origin` is `existing`. */
  readonly baseline: string | null
  /** What the first mutation found at the path. */
  readonly origin: BaselineOrigin
  /**
   * 本次会话最后一次改动之后的内容；该路径被删除时为空。
   *
   * 被删除路径的内容活在工作区的 git 对象里，因此这条记录从不携带它，恢复也不读它。
   */
  readonly endState: string
  /** Operation kind of the first mutation. */
  readonly operation: RevisionOperation
  /** Position of the first mutation; decides the list's first-seen order. */
  readonly firstOrder: RevisionOrder
  /** Position of the last mutation. */
  readonly lastOrder: RevisionOrder
}
