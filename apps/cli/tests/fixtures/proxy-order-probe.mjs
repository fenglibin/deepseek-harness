/**
 * 测试专用 Cordis 插件：在挂载瞬间报告「代理策略是否已发布」。
 *
 * `installProxyFromEnvironment` 的同一调用会做两件事：构造 dispatcher，并把解析
 * 出的策略写回代理环境变量（含 `ALL_PROXY` 回退与合并后的 loopback 绕过，因此
 * 一定会补上 `NO_PROXY`，无论调用方是否声明过它）。所以「挂载时 `NO_PROXY` 已
 * 存在」就是「安装发生在本次挂载之前」的充分证据。
 *
 * 不调用 `proxyRouteFor` 判定：那读到的是本模块自己那份 http-proxy 实例，与启动器
 * 安装的那份不属于同一模块注册表，恒为「未安装」。
 */

export const name = 'proxy-order-probe'

export const inject = []

/** 挂载时报告策略是否已发布，随后结束进程。 */
export function apply() {
  const installed = process.env.NO_PROXY !== undefined
  process.stdout.write(`dsh-probe: installed=${String(installed)}\n`)
  setTimeout(() => { process.exit(0) }, 50)
}
