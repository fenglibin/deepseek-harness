/**
 * `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` 的包自有不变式伴生入口。
 * @module @deepseek-ai/dsh-client-ui-settings-unarchive-sessions/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-unarchive-sessions'

/** Cordis 伴生插件名。 */
export const name = 'client-ui-settings-unarchive-sessions-invariant'
/** 伴生入口认领包归属之前所需的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 一个只渲染已归档会话列表的设置分节插件——它不发出
 * Cordis 事件，也不持有跨插件可变关系。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变式伴生入口。
 * @param ctx - 携带不变式服务的 Cordis 上下文。
 * @returns 安装成功后的注销函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
