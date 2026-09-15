/**
 * 真实 MCP 资源服务器经 `dsh-mcp-client` 的端到端接线：三个共享工具读到该
 * 服务器的资源，服务器 instructions 以字面量段落进入系统提示词。
 *
 * 用真实的 stdio 子进程而非 mock，因此覆盖的是协议往返、连接代际与资源
 * 渲染三者的组合。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { apply as applyMcpClient } from '../src/index.ts'
import { BINARY_BASE64 } from './fixtures/resources-server.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

/** 该 fixture 服务器脚本的绝对路径。 */
const FIXTURE = fileURLToPath(new URL('./fixtures/resources-server.ts', import.meta.url))

/**
 * 装配一个挂载了真实 stdio MCP 服务器的 Host 上下文。
 * @returns 已连上 fixture 服务器的上下文。
 */
async function setup(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(SubprocessRuntime)
  await ctx.plugin(McpResources)
  // mcp-client 是函数插件（具名导出 name/inject/Config/apply），config 作为 apply 的第二个参数。
  await ctx.plugin({
    name: 'mcp-client',
    inject: ['tools'],
    apply: (inner: Context) => applyMcpClient(inner, {
      transport: 'stdio',
      serverName: 'catalog',
      command: process.execPath,
      args: ['--import', 'tsx/esm', FIXTURE],
      failOnStartupError: true,
      reconnect: { enabled: false },
    }),
  })
  return ctx
}

/**
 * 调用一个工具并返回其文本渲染结果。
 * @param ctx - 已装配的上下文。
 * @param name - 工具名。
 * @param args - 工具参数。
 * @returns 结果中拼接的文本块，以及是否出错。
 */
async function callTool(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = await ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId(`probe-${name}`),
    signal: new AbortController().signal,
  })
  const blocks = Array.isArray(result.content) ? result.content : [result.content]
  const text = blocks
    .filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
    .map(block => block.text)
    .join('\n')
  return { text, isError: result.isError }
}

describe('真实 MCP 资源服务器的端到端接线', () => {
  it('三个工具列出并读取该服务器的资源', async () => {
    const ctx = await setup()

    const listed = await callTool(ctx, 'list_mcp_resources', { server: 'catalog' })
    expect(listed.isError).toBe(false)
    expect(listed.text).toContain('memo://text')
    expect(listed.text).toContain('memo://binary')
    // 结果标明来源服务器。
    expect(listed.text).toContain('catalog')

    const templates = await callTool(ctx, 'list_mcp_resource_templates', { server: 'catalog' })
    expect(templates.isError).toBe(false)
    expect(templates.text).toContain('memo://greeting/{name}')

    const read = await callTool(ctx, 'read_mcp_resource', { server: 'catalog', uri: 'memo://text' })
    expect(read.isError).toBe(false)
    // 文本内容原样进入模型可见输出，花括号保持字面量。
    expect(read.text).toContain('MCP resource text with {{braces}} intact.')
  })

  it('二进制载荷以说明文字呈现，原始 base64 不进模型可见文本', async () => {
    const ctx = await setup()
    const read = await callTool(ctx, 'read_mcp_resource', { server: 'catalog', uri: 'memo://binary' })
    expect(read.isError).toBe(false)
    expect(read.text).toContain('binary resource')
    expect(read.text).not.toContain(BINARY_BASE64)
  })

  it('URI 模板展开后可读，且缺服务器参数在派发前失败', async () => {
    const ctx = await setup()
    const expanded = await callTool(ctx, 'read_mcp_resource', { server: 'catalog', uri: 'memo://greeting/Ada' })
    expect(expanded.isError).toBe(false)
    expect(expanded.text).toContain('Hello, Ada.')

    const missing = await callTool(ctx, 'list_mcp_resources', {})
    expect(missing.isError).toBe(true)
  })

  it('服务器 instructions 作为字面量段落进入系统提示词', async () => {
    const ctx = await setup()
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('MCP_RESOURCE_INSTRUCTION')
    // `interpolate: false` 让花括号保持字面量而不被当作未知变量。
    expect(prompt).toContain('{{braces}}')
  })
})
