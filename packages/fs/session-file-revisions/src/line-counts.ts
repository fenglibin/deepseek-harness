/**
 * 一次修订累计变更的新增与删除行数。
 *
 * 两个计数描述的是**变更**本身而非两侧文件：只有一行被改写的文件报告新增
 * 一行、删除一行，与文件总长无关。若按两侧总行数报告，一次单行修改就会被
 * 说成整文件重写。
 *
 * 无基线可比的修订两侧均为 0：两个计数都不可推导，把结束状态的行数算作新增
 * 会声称一个捕获无法支持的整文件新增。被删除的路径出于相反的理由处于同样
 * 位置——恢复动作并不作用于它的内容侧，而由界面呈现删除这一事实。
 *
 * @module @deepseek-ai/dsh-session-file-revisions/line-counts
 */

import { diffLines } from 'diff'
import type { FileRevision } from './types.ts'

/** 一次变更的新增与删除行数。 */
export interface LineCounts {
  /** 该变更新增的行数。 */
  readonly added: number
  /** 该变更删除的行数。 */
  readonly removed: number
}

/**
 * 数一个差异片段包含的行数。
 *
 * 结尾换行终止最后一行而不是另起一个空行。`diffLines` 只在确有增删时产出片段，
 * 且每段的文本非空，因此这里不需要为空文本设分支。
 * @param value - 差异片段的一侧文本。
 * @returns 该侧的行数。
 */
function countLines(value: string): number {
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0)
}

/**
 * 一次修订的新增与删除行数。
 *
 * `diffLines` 把缺席的基线当作空文本比较，因此会话新建的文件无需特例就是纯新增。
 * @param revision - 待测量的修订。
 * @returns 其新增与删除行数。
 */
export function lineCounts(revision: Pick<FileRevision, 'origin' | 'baseline' | 'endState'>): LineCounts {
  if (revision.origin === 'unknown' || revision.origin === 'deleted') {
    return { added: 0, removed: 0 }
  }
  let added = 0
  let removed = 0
  for (const part of diffLines(revision.baseline ?? '', revision.endState)) {
    if (part.added === true) added += countLines(part.value)
    else if (part.removed === true) removed += countLines(part.value)
  }
  return { added, removed }
}
