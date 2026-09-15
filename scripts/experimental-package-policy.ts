/**
 * 实验包发布策略的单一真相源：发布成员发现、工作区约束校验与 npm baseline
 * 脚本都从这里读取同一个判定。
 *
 * 命名约定（`@deepseek-ai/dsh-experimental-` 前缀）是另一个正交契约，由
 * `scripts/check-workspace-constraints.ts` 独立强制。
 */

/**
 * 不参与公开发布与 npm baseline 的实验包目录。
 *
 * 本地实验包的产品化程度低于上游，因此清单默认为空的上游语义（「默认公开 +
 * 显式私有例外」）不适用：这里逐个列出本地全部 8 个实验包，保持它们私有。
 * 摘除某个目录即表示该实验包进入发布成员集合。
 */
export const PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES: readonly string[] = [
  'packages/experimental/agent-team',
  'packages/experimental/agent-team-profile',
  'packages/experimental/agent-team-web-profile',
  'packages/experimental/client-ui-agent-team',
  'packages/experimental/inspector',
  'packages/experimental/tool-agent-team',
  'packages/experimental/webworker-packer',
  'packages/experimental/webworker-runtime',
]

/**
 * 判断一个实验包是否按默认公开策略发布。
 * @param directory - 仓库相对包目录。
 * @param privateDirectories - 排除在发布之外的实验包目录。
 * @returns 该包是否随 dsh 家族发布；非实验包目录一律返回 `false`。
 */
export function isPublicExperimentalPackageDirectory(
  directory: string,
  privateDirectories: readonly string[] = PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
): boolean {
  return /^packages\/experimental\/[^/]+$/.test(directory)
    && !privateDirectories.includes(directory)
}

/**
 * 判断一个目录是否是被排除在发布之外的实验包目录，即发布成员过滤的补集。
 *
 * 发布成员是「全部非实验包目录」加上「策略判为公开的实验包目录」，调用方
 * 用本判定取反即可表达，无需重复目录前缀判断。
 * @param directory - 仓库相对包目录。
 * @param privateDirectories - 排除在发布之外的实验包目录。
 * @returns 该目录是否必须从发布成员中排除。
 */
export function isPrivateExperimentalPackageDirectory(
  directory: string,
  privateDirectories: readonly string[] = PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
): boolean {
  return /^packages\/experimental\/[^/]+$/.test(directory)
    && privateDirectories.includes(directory)
}
