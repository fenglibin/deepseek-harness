/**
 * 按作用域的 MCP 资源提供方，以及三个共享的、面向模型的资源工具。
 *
 * @module @deepseek-ai/dsh-mcp-resources
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { createScope, NamedEntries, ScopedLayers, scopeOf, type ScopeKey, type ScopeLayer } from '@deepseek-ai/dsh-scope'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerResourceTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpResources: McpResourceRuntime
  }
}

/** 一次受支持的资源操作，游标与 URI 由服务器拥有。 */
export type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }

/** 一个已配置服务器的资源访问，由它的 MCP 连接插件拥有。 */
export interface McpResourceProvider {
  /**
   * 针对一个存活的连接代际执行一次操作。
   * @param request - MCP 资源方法与参数。
   * @param exec - 本次调用的调用方身份与取消信号。
   * @returns 协议结果，以无损 JSON 表示。
   */
  request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue>
}

class ResourceLayer implements ScopeLayer {
  readonly servers = new NamedEntries<McpResourceProvider>(name =>
    new Error(`MCP resource server "${name}" is already registered in this scope`))
  disposeTools: (() => void | Promise<void>) | undefined

  isEmpty(): boolean {
    return this.servers.isEmpty()
  }
}

/** 按作用域的资源访问，加上由已配置 MCP 服务器共享的三个工具。 */
export class McpResourceRuntime extends Service {
  /** 资源消费方需要的工具注册表。 */
  static inject = ['tools']

  private readonly layers = new ScopedLayers(() => new ResourceLayer(), () => undefined)
  /** 共享工具注册比任何单个服务器的注册上下文存活更久。 */
  private readonly selfCtx: Context

  constructor(ctx: Context) {
    super(ctx, 'mcpResources')
    this.selfCtx = ctx

    ctx.inject(['systemPrompt'], (inner) => {
      inner.systemPrompt.section({
        name: 'mcp-resource-servers',
        order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
        interpolate: false,
        text: ({ scope }) => {
          const names = [...this.layers.merge(scope, layer => layer.servers).keys()].sort()
          return names.length === 0 ? '' : '## MCP resource servers\n\n'
            + 'Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names '
            + `as the server argument: ${JSON.stringify(names)}.`
        },
      })
    })
  }

  /**
   * 注册一个服务器，并在该作用域存在提供方期间暴露资源工具。
   * @param server - 已配置的服务器名，在本作用域内唯一。
   * @param provider - 由连接拥有的资源操作。
   * @returns 这次确切注册的 effect disposer。
   */
  register(server: string, provider: McpResourceProvider): () => void {
    const ctx = this.ctx
    const scope = scopeOf(ctx)
    const dispose = ctx.effect(function* (this: McpResourceRuntime) {
      let disposal: void | Promise<void>
      // 工具同步消失；挂起的按作用域 fiber 拆除由 Cordis 拥有。
      yield () => disposal
      yield this.layers.effect(ctx, (layer) => {
        const first = layer.servers.isEmpty()
        const remove = layer.servers.insert(server, provider)
        try {
          if (first) layer.disposeTools = this.registerTools(scope)
        } catch (error) {
          remove()
          throw error
        }
        return () => {
          remove()
          // oxlint-disable-next-line typescript/no-non-null-assertion -- 提供方注册成功后即拥有这组共享工具
          if (layer.servers.isEmpty()) disposal = layer.disposeTools!()
        }
      }, { label: `mcpResources.provider(${server})` })
    }.bind(this), `mcpResources.register(${server})`)
    // oxlint-disable-next-line typescript/no-misused-promises -- 可见性清理是同步的；挂起的 fiber 拆除由 Cordis 保留
    return dispose
  }

  /** 独立于已配置的服务器插件，拥有某个作用域的工具。 */
  private registerTools(scope: ScopeKey | undefined): () => void | Promise<void> {
    const ctx = this.selfCtx
    return ctx.effect(function* (this: McpResourceRuntime) {
      let toolCtx = ctx
      if (scope !== undefined) {
        const owned = createScope(ctx, scope)
        yield owned.rawDispose
        toolCtx = owned.ctx
      }
      yield registerResourceTools(toolCtx, (server, request, exec) => this.request(server, request, exec))
    }.bind(this), 'mcpResources.tools')
  }

  /** 在发起任何网络操作之前解析调用方可见的服务器。 */
  private request(server: string, request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue> {
    const provider = this.layers.merge(exec.agent, layer => layer.servers).get(server)
    if (!provider) throw new Error(`MCP resource server "${server}" is unavailable in this agent's scope`)
    return provider.request(request, exec)
  }
}

export default McpResourceRuntime
