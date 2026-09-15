/**
 * `@deepseek-ai/dsh-mcp-resources` 的包自有不变式伴生入口。
 * @module @deepseek-ai/dsh-mcp-resources/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-resources'

/** Cordis 伴生插件名。 */
export const name = 'mcp-resources-invariant'
/** 伴生插件声明包归属前需要就绪的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 作用域提供方集合与共享工具注册由同一个 owner
 * 在同一个 effect 事务里维护，没有可供比对的独立运行时来源；提供方存活与
 * 工具出现/移除的配对关系由行为测试断言。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变式伴生插件。
 * @param ctx - 携带不变式服务的 Cordis 上下文。
 * @returns 安装成功后该注册的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
