/**
 * 浏览器半身：`ctx.resources`（按协议注册的提供方、pin、实时来源）以及
 * `useResource` 全局标准钩子。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 仅类型用的服务合并，为 ctx.slots 提供类型。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots'
import { ResourceRegistry } from './resources.ts'

export type {
  ResourceOpenContext,
  ResourceProtocol,
  ResourceProvider,
  Resources,
  ResourceSnapshot,
  ResourceStatus,
  UseResource,
} from './contract.ts'
export type { ResourceProtocolMap } from '@deepseek-ai/dsh-client-ui-slots'

/** 必需的浏览器服务。 */
export const inject = ['slots']

/**
 * 客户端插件体：提供 `ctx.resources`，并贡献 `resource` 根级 keyed 钩子，
 * 使每个 slot 组件都以 `useResource` 收到它。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  // 在 apply 顶层构造，绝不放进 effect：其他插件会从自己的 apply 调用
  // `register()`，而它会把 effect 加到本 fiber 上。
  const resources = new ResourceRegistry(ctx)
  const disposeService = ctx.reflect.provide('resources', resources)
  // 最先注册，因此最后拆除：服务面比注册进它的每个提供方存活更久。
  ctx.effect(() => () => { void disposeService() }, 'client-resources: service face')
  ctx.slots.provideRoot({
    keyedHooks: { resource: address => resources.source(address) },
  } satisfies RootStandardSourceContribution)
}
