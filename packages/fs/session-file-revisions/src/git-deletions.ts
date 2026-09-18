/**
 * 会话期间被删除的路径，通过询问工作区的 git 状态得出。
 *
 * 识别不解析 shell 命令文本。bash 是任意代码——`find . -delete`、`for` 循环、
 * `python -c "os.remove(...)"`、`git clean -fd` 都无法用命令文本穷尽，而漏认与
 * 错认都会让读者看到一个错误的列表。git 状态是**结果**而非**意图**，因此天然
 * 覆盖脚本与间接删除，也与删除是怎么发生的无关。
 *
 * `git status` 报告的是工作区当前全部删除，不区分是否本会话所为，所以在会话内
 * 首次查询时记一份删除基线，之后只报告相对该基线的增量：会话开始前就删除的、
 * 以及会话外删除的路径不会出现在列表里。
 *
 * git 不可用（工作区不是仓库、命令失败、输出无法解析）一律当作「没有删除」而
 * 非错误：该能力是列表的增强，缺少它时列表照常工作，只是不显示删除行。
 *
 * @module @deepseek-ai/dsh-session-file-revisions/git-deletions
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'

/** 一次 git 查询的结果：已删除路径，或该工作区无法回答。 */
export type DeletionScan =
  | { readonly kind: 'ok'; readonly paths: readonly string[] }
  /** 工作区不是 git 仓库，或 git 调用失败；调用方按「没有删除」处理。 */
  | { readonly kind: 'unavailable'; readonly reason: 'not-a-repository' | 'failed' }

/**
 * 解析 `git status --porcelain -z` 输出中的删除项。
 *
 * `-z` 用 NUL 分隔条目与重命名对，因此路径中的空格与引号无需转义处理。每条目
 * 的前两个字符是索引与工作区状态，`D` 在任一位置都表示该路径相对 `HEAD` 被删除。
 * 重命名条目（`R`）后面还跟一条目标路径，必须跳过，否则目标会被误当成一个状态。
 * @param output - `git status --porcelain -z` 的原始 stdout。
 * @returns 按输出顺序排列的已删除路径。
 */
export function parseDeletedPaths(output: string): readonly string[] {
  const paths: string[] = []
  const entries = output.split('\0')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined || entry.length < 4) continue
    const indexStatus = entry[0]
    const worktreeStatus = entry[1]
    // 重命名的源与目标各占一条；目标的路径是下一条并且不带状态前缀。
    if (indexStatus === 'R' || worktreeStatus === 'R') {
      index += 1
      continue
    }
    if (indexStatus === 'D' || worktreeStatus === 'D') paths.push(entry.slice(3))
  }
  return paths
}

/**
 * 查询一个工作区当前被删除的路径，返回**绝对路径**。
 *
 * `-uall` 是必需的：默认状态下 git 把未跟踪的目录折叠成一条 `?? dir/`，而这里
 * 需要逐文件的事实来与基线比较。命令用 `-C` 指定工作区而不是进程的 cwd，因为
 * 会话工作区与本进程的 cwd 无关。
 *
 * 报告的路径是**仓库相对**的，即使 `-C` 指向的是仓库的子目录（git 的行为如此），
 * 因此必须先用 `rev-parse --show-toplevel` 取到仓库根再解析。直接用工作区根解析
 * 会在工作区是仓库子目录时把前缀重复一遍——`proj/a.txt` 变成 `proj/proj/a.txt`。
 * 工作的路径是会话工作区内的绝对路径，所以相对工作区之外的删除在下一步被丢弃。
 * @param run - 无 shell 命令执行边界。
 * @param workspaceRoot - 会话工作区根，git 在其中执行。
 * @param signal - 调用方生命周期信号。
 * @returns 该工作区的删除扫描结果。
 */
export async function scanDeletedPaths(
  run: NativeCommandRunner,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<DeletionScan> {
  try {
    const { stdout } = await run('git', ['-C', workspaceRoot, 'status', '--porcelain', '-z', '-uall'], signal)
    const relative = parseDeletedPaths(stdout)
    if (relative.length === 0) return { kind: 'ok', paths: [] }
    const root = await repositoryRoot(run, workspaceRoot, signal)
    if (root === undefined) return { kind: 'unavailable', reason: 'failed' }
    return { kind: 'ok', paths: insideWorkspace(root, workspaceRoot, relative) }
  } catch (error: unknown) {
    // git 自己报的「不是仓库」与「调用失败」对读者是同一件事：这个工作区没有
    // 可用的删除信息。区分它们不会让列表多显示一行，所以两者合并。
    return { kind: 'unavailable', reason: isNotARepository(error) ? 'not-a-repository' : 'failed' }
  }
}

/**
 * 一个工作区所属仓库的根目录。
 * @param run - 无 shell 命令执行边界。
 * @param workspaceRoot - 会话工作区根。
 * @param signal - 调用方生命周期信号。
 * @returns 仓库根的绝对路径，或 undefined（git 无法回答）。
 */
async function repositoryRoot(
  run: NativeCommandRunner,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['-C', workspaceRoot, 'rev-parse', '--show-toplevel'], signal)
    const root = stdout.trim()
    return root.length === 0 ? undefined : root
  } catch {
    return undefined
  }
}

/**
 * 把仓库相对的删除路径解析成绝对路径，并只保留会话工作区之内的那些。
 *
 * 工作区之外的删除不是这次会话要展示的东西：列表只描述会话工作区。一个也不剩时
 * 返回空，调用方无需再判空。
 *
 * 两侧都先用 `realpath` 归一化：git 报告的仓库根是解析过符号链接的真实路径
 * （macOS 上 `/tmp` 会变成 `/private/tmp`），而调用方传来的是它构造工作区时的原样
 * 拼写，直接比较会一个也匹配不上。判定的结果再按**调用方的拼写**重新拼出，因为
 * 修订记录与写工具走的是同一套规范化，若这里返回真实路径，同一个文件就会因拼写
 * 不同而占两条记录。
 * @param repositoryRoot - 仓库根的绝对路径。
 * @param workspaceRoot - 会话工作区根的绝对路径。
 * @param relativePaths - git 报告的仓库相对路径。
 * @returns 工作区内、按工作区拼写的绝对路径。
 */
function insideWorkspace(
  repositoryRoot: string,
  workspaceRoot: string,
  relativePaths: readonly string[],
): readonly string[] {
  const realRepository = resolveSymlinks(repositoryRoot)
  const realWorkspace = resolveSymlinks(workspaceRoot)
  const local = workspaceRoot.replace(/[/\\]+$/, '')
  const out: string[] = []
  for (const relativePath of relativePaths) {
    const absolute = resolve(realRepository, relativePath)
    if (absolute !== realWorkspace && !absolute.startsWith(`${realWorkspace}/`)) continue
    out.push(absolute === realWorkspace ? local : `${local}/${absolute.slice(realWorkspace.length + 1)}`)
  }
  return out
}

/**
 * 一个路径解析符号链接后的真实拼写。
 * @param path - 待解析的路径。
 * @returns 真实路径；无法解析时保持原样。
 */
function resolveSymlinks(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * 判断一次 git 失败是否因为该目录不是仓库。
 *
 * `execFile` 的失败消息本身包含子进程的 stderr，因此不需要再去读 `stderr` 字段。
 * @param error - git 调用抛出的失败。
 * @returns true 表示 git 明确报告这里不是仓库。
 */
function isNotARepository(error: unknown): boolean {
  return String(error).includes('not a git repository')
}

/**
 * 按会话记录的删除基线：首次查询记下当时已删除的路径，之后只报告新增的删除。
 *
 * 每个会话一份，因为归属是「本会话期间变成已删除」而不是「工作区里正被删除」。
 * 基线不可变：它记录的是会话开始时的既成事实，后续查询不应把它推后。
 *
 * 基线必须在**第一条可能删除文件的命令执行之前**建立，否则那条命令自己的删除
 * 会被折进基线而永远不被报告。{@link establish} 与 {@link known} 分开存在，正是
 * 为了让「尚未建立」与「已建立且为空」可区分——后者是工作区本来就没有删除的会话，
 * 前者还需要一次扫描。
 */
export class DeletionBaseline {
  /** 会话 id → 该会话首次查询时已存在的删除路径。 */
  private readonly baselines = new Map<string, ReadonlySet<string>>()

  /**
   * 该会话是否已建立基线。
   * @param sessionId - 查询归属的会话。
   * @returns true 表示已经扫描过，无需再扫。
   */
  known(sessionId: string): boolean {
    return this.baselines.has(sessionId)
  }

  /**
   * 记下该会话的基线。
   *
   * 重复调用不覆盖：基线是会话开始时的既成事实，后来的扫描只会看到更多删除，
   * 若把它推后，先前报告过的删除会被当成基线而消失。
   * @param sessionId - 归属的会话。
   * @param paths - 此刻工作区中已删除的全部路径。
   */
  establish(sessionId: string, paths: readonly string[]): void {
    if (this.baselines.has(sessionId)) return
    this.baselines.set(sessionId, new Set(paths))
  }

  /**
   * 相对该会话基线新增的删除路径。
   *
   * 基线尚未建立时先建立，因此这一次的返回值必然为空——这是有意的：会话开始时
   * 已经删除的文件不是本会话改的。
   * @param sessionId - 查询归属的会话。
   * @param current - 本次扫描到的全部已删除路径。
   * @returns 本会话期间新出现的已删除路径。
   */
  since(sessionId: string, current: readonly string[]): readonly string[] {
    if (!this.baselines.has(sessionId)) {
      this.establish(sessionId, current)
      return []
    }
    const baseline = this.baselines.get(sessionId) as ReadonlySet<string>
    return current.filter(path => !baseline.has(path))
  }

  /**
   * 遗忘一个会话的基线。
   * @param sessionId - 要遗忘的会话。
   */
  forget(sessionId: string): void {
    this.baselines.delete(sessionId)
  }
}
