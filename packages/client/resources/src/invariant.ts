/**
 * `@deepseek-ai/dsh-client-resources` 的包自有不变式伴生入口。
 * @module @deepseek-ai/dsh-client-resources/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-resources'

/** Cordis 伴生插件名。 */
export const name = 'client-resources-invariant'
/** 伴生插件声明包归属前需要就绪的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 提供方归属与持有者计数只有注册表这一个拥有者，没有可供
 * 比对的独立运行时来源；注册的 dispose 与开流/停流生命周期由行为测试断言。
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
