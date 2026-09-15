/**
 * 发布由连接拥有的 MCP 资源与字面量服务器指令。
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** 由连接拥有、供资源与提示词消费方使用的值。 */
export interface ServerContext {
  /** 经当前连接代际的资源访问。 */
  resources: McpResourceProvider
  /**
   * 读取最后一次成功连接的服务器带来源标注的指令。
   * @returns 字面量提示词文本；当前没有生效的服务器指令时为空字符串。
   */
  instructions(): string
}

/**
 * 把服务器上下文贡献给本组合启用的那些服务。
 * @param ctx - 服务器插件的注册作用域与 effect 拥有者。
 * @param server - 已配置的服务器标识。
 * @param connection - 存活的资源操作与最近一次成功的指令快照。
 */
export function registerServerContext(ctx: Context, server: string, connection: ServerContext): void {
  ctx.inject(['mcpResources'], (inner) => {
    inner.mcpResources.register(server, connection.resources)
  })
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: `mcp:${server}`,
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
      interpolate: false,
      text: () => connection.instructions(),
    })
  })
}
