/**
 * 从工作区的 git 对象恢复一个被删除的路径。
 *
 * 内容来源有两个，顺序是固定的，因为文件当初是否进过 git 决定了哪个来源持有它：
 *
 * 1. `git restore --source=HEAD`，用于在 `HEAD` 中存在过的路径。
 * 2. `git cat-file -p :<path>`，用于只存在于 index 的路径——本次会话创建并
 *    `git add` 但从未提交的文件。`restore --source=HEAD` 对这类路径**静默失败**，
 *    因此它必须排在第二位尝试，而不是替代 `restore`。
 *
 * 两种失败是读者可以据此行动的不同处境，所以分别报告而不是合并成一句：git 从未
 * 听说过的路径在这台机器上任何地方都没有它的内容；不是仓库的工作区则根本没有 git
 * 的答案。
 *
 * @module @deepseek-ai/dsh-session-file-revisions/git-restore
 */

import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'

/**
 * 一次恢复尝试的结果。
 *
 * `restored` 带回内容与它的来源，让调用方在写盘时不必关心是哪一侧给的；
 * `blocked` 命名无法恢复的原因。
 */
export type RestoreOutcome =
  | { readonly kind: 'restored'; readonly content: string; readonly source: 'head' | 'index' }
  | { readonly kind: 'blocked'; readonly reason: 'not-in-git' | 'not-a-repository' }

/**
 * 一次 git 调用的失败分类。
 *
 * `not-a-repository` 与其它失败分开，因为只有它对应一个读者能理解的处境；其余
 * 失败（git 缺失、权限、超时）对读者是同一件事：这次恢复没能完成。
 */
type GitFailure = 'not-a-repository' | 'failed'

/**
 * 判断一次 git 失败是否因为它运行在不属于仓库的目录里。
 *
 * `execFile` 的失败消息本身包含子进程的 stderr，因此不需要再去读 `stderr` 字段。
 * @param error - git 调用抛出的失败。
 * @returns true 表示 git 明确报告这里不是仓库。
 */
function classify(error: unknown): GitFailure {
  return String(error).includes('not a git repository') ? 'not-a-repository' : 'failed'
}

/**
 * 运行一次 git 并捕获它的输出。
 * @param run - 无 shell 命令执行边界。
 * @param root - git 运行的工作区根。
 * @param args - git 参数，以 argv 数组传递，不经 shell。
 * @param signal - 调用方生命周期信号。
 * @returns 成功时的 stdout，或失败分类。
 */
async function git(
  run: NativeCommandRunner,
  root: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ ok: true; stdout: string } | { ok: false; failure: GitFailure }> {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], signal)
    return { ok: true, stdout }
  } catch (error: unknown) {
    return { ok: false, failure: classify(error) }
  }
}

/**
 * 恢复一个被删除路径的内容。
 *
 * 只取内容，不写盘：调用方持有已收敛的绝对路径与原子写，这里不重复那套职责。
 *
 * git 的 `HEAD:<path>` 与 `:<path>` 都要求**仓库相对**路径，而调用方持有的是工作区
 * 内的绝对路径。两者只在工作区就是仓库根时相同；工作区是仓库子目录时，直接拿
 * 工作区相对路径去问会得到「path exists, but not ...」而恢复失败，因此这里自己
 * 用 `rev-parse --show-prefix` 取到工作区在仓库中的前缀再拼。
 * @param run - 无 shell 命令执行边界。
 * @param root - 会话工作区根。
 * @param absolutePath - 工作区内待恢复文件的绝对路径。
 * @param signal - 调用方生命周期信号。
 * @returns 取回的内容，或无法恢复的原因。
 */
export async function readDeletedContent(
  run: NativeCommandRunner,
  root: string,
  absolutePath: string,
  signal: AbortSignal,
): Promise<RestoreOutcome> {
  // git answers with symlink-resolved paths (macOS `/tmp` is `/private/tmp`), so
  // git runs against the resolved root. The workspace-relative remainder comes
  // from the CALLER's spellings instead: the file is deleted, so it has no
  // resolvable real path, and subtracting a resolved root from an unresolved
  // file path would cut two unrelated prefixes.
  const realRoot = resolveSymlinks(root)
  const prefix = await git(run, realRoot, ['rev-parse', '--show-prefix'], signal)
  if (!prefix.ok) {
    return prefix.failure === 'not-a-repository'
      ? { kind: 'blocked', reason: 'not-a-repository' }
      : { kind: 'blocked', reason: 'not-in-git' }
  }
  // `--show-prefix` answers with a trailing slash (or nothing at the repo root),
  // so the repository-relative spelling is the prefix plus the workspace-relative
  // one.
  const repositoryRelative = `${prefix.stdout.trim()}${relative(root, absolutePath)}`
  const fromHead = await git(run, realRoot, ['show', `HEAD:${repositoryRelative}`], signal)
  if (fromHead.ok) return { kind: 'restored', content: fromHead.stdout, source: 'head' }
  const fromIndex = await git(run, realRoot, ['cat-file', '-p', `:${repositoryRelative}`], signal)
  if (fromIndex.ok) return { kind: 'restored', content: fromIndex.stdout, source: 'index' }
  // Both sources refused: a path git never tracked has no object anywhere on
  // this machine, so nothing can bring its content back.
  return { kind: 'blocked', reason: 'not-in-git' }
}

/**
 * 一个路径解析符号链接后的真实拼写。
 * @param path - 待解析的路径。
 * @returns 真实路径；路径或其某段不存在时保持原样。
 */
function resolveSymlinks(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
