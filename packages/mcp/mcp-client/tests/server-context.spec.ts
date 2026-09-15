/**
 * 服务器上下文接线：指令以字面量段落注入并随作用域释放撤回，资源提供方
 * 与段落同生共死。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { createScope } from '@deepseek-ai/dsh-scope'
import { registerServerContext } from '../src/server-context.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(McpResources)
  return ctx
}

describe('MCP server context', () => {
  it('注入字面量指令，并让段落与资源提供方一起撤回', async () => {
    const ctx = await setup()
    let instructions = 'MCP server: docs\nKeep {{server.template}} literal.'
    const fiber = await ctx.plugin({
      apply(inner: Context) {
        registerServerContext(inner, 'docs', {
          resources: { request: async () => ({ resources: [] }) },
          instructions: () => instructions,
        })
      },
    })
    // 花括号保持字面量：段落的 interpolate 是 false，未注册的变量不会抛错。
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(instructions)
    instructions = 'MCP server: docs\nUpdated instructions.'
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(instructions)
    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP server: docs')
    const result = await ctx.tools.execute({
      name: 'list_mcp_resources', arguments: { server: 'docs' },
      callId: ToolCallId('disposed-resource'), signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
  })

  it('空指令不留下段落', async () => {
    const ctx = await setup()
    await ctx.plugin({
      apply(inner: Context) {
        registerServerContext(inner, 'silent', {
          resources: { request: async () => ({ resources: [] }) },
          instructions: () => '',
        })
      },
    })
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'mcp:silent')).toBe(true)
    // 空文本的段落不进最终提示词。
    expect(renderPrompt(assembly)).not.toContain('mcp:silent')
  })

  it('作用域化的指令只对该作用域可见', async () => {
    const ctx = await setup()
    const scopeKey = {}
    await ctx.plugin({
      apply(inner: Context) {
        const scoped = createScope(inner, scopeKey)
        registerServerContext(scoped.ctx, 'private', {
          resources: { request: async () => ({ resources: [] }) },
          instructions: () => 'Private server instructions.',
        })
      },
    })
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKey }))).toContain('Private server instructions.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Private server instructions.')
  })

  it('未挂载 mcp-resources 时客户端仍工作：只贡献段落，不注册资源', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    // 刻意不挂 McpResources。
    await ctx.plugin({
      apply(inner: Context) {
        registerServerContext(inner, 'docs', {
          resources: { request: async () => ({ resources: [] }) },
          instructions: () => 'MCP server: docs\nStandalone instructions.',
        })
      },
    })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Standalone instructions.')
    expect(ctx.tools.get('list_mcp_resources')).toBeUndefined()
  })
})
