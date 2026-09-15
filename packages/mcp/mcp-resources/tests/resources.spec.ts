/**
 * 按作用域的 MCP 资源访问与三个共享资源工具：工具随提供方存活、作用域可见性、
 * 以及二进制载荷的渲染取舍。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import McpResources, { type McpResourceProvider } from '../src/index.ts'
import { renderResourceResult } from '../src/render.ts'

const resourceToolNames = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(McpResources)
  return ctx
}

/** 在一个已有作用域内建立一个注册上下文。 */
async function resourceScope(ctx: Context, owner: Agent) {
  let scoped!: ReturnType<typeof createScope>
  await ctx.plugin({
    inject: ['mcpResources', 'tools'],
    apply(inner: Context) { scoped = createScope(inner, owner) },
  })
  return scoped
}

function visibleResourceTools(ctx: Context, agent?: Agent): string[] {
  return ctx.tools.schemas(agent).map(tool => tool.name).filter(name => resourceToolNames.includes(name)).sort()
}

function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    name, arguments: args, callId: ToolCallId('resource-test'),
    signal: new AbortController().signal,
    ...agent === undefined ? {} : { agent },
  })
}

describe('MCP resource tools', () => {
  it('没有提供方时三个资源工具都不存在，也不留下提示词段落', async () => {
    const ctx = await setup()
    expect(visibleResourceTools(ctx)).toEqual([])
    const assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).not.toContain('mcp')
    expect(assembly.tools.map(tool => tool.name).filter(name => resourceToolNames.includes(name))).toEqual([])
    for (const name of resourceToolNames) {
      expect(ctx.tools.get(name)).toBeUndefined()
      expect(await call(ctx, name, { server: 'missing', uri: 'docs://text' }))
        .toMatchObject({ isError: true })
    }
  })

  it('首个提供方使工具出现，最后一个卸载时移除，且允许重新注册', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const first = await ctx.plugin({
      inject: ['mcpResources'],
      apply(inner: Context) { inner.mcpResources.register('first', { request }) },
    })
    const second = await ctx.plugin({
      inject: ['mcpResources'],
      apply(inner: Context) { inner.mcpResources.register('second', { request }) },
    })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    await first.dispose()
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    expect((await call(ctx, 'list_mcp_resources', { server: 'second' })).isError).toBe(false)
    await second.dispose()
    expect(visibleResourceTools(ctx)).toEqual([])
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP resource servers')

    const remove = ctx.mcpResources.register('second', { request })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    remove()
    expect(visibleResourceTools(ctx)).toEqual([])
    remove()
    expect(visibleResourceTools(ctx)).toEqual([])
    const replace = ctx.mcpResources.register('second', { request })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    replace()
    expect(visibleResourceTools(ctx)).toEqual([])
  })

  it('同一作用域内重复注册同一个服务器名会被拒绝', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    ctx.mcpResources.register('docs', { request })
    expect(() => ctx.mcpResources.register('docs', { request }))
      .toThrow('MCP resource server "docs" is already registered in this scope')
  })

  it('只在属主与其后代中可见，并在请求前解析服务器名', async () => {
    const ctx = await setup()
    const owner = {} as Agent
    const child = {} as Agent
    const sibling = {} as Agent
    bindScopeParent(child, owner)
    const scoped = await resourceScope(ctx, owner)
    const localRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const globalRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const removeLocal = scoped.ctx.mcpResources.register('docs', { request: localRequest })
    for (const agent of [owner, child]) {
      expect(visibleResourceTools(ctx, agent)).toEqual([...resourceToolNames].sort())
      expect((await call(ctx, 'list_mcp_resources', { server: 'docs' }, agent)).isError).toBe(false)
    }
    for (const agent of [undefined, sibling]) {
      expect(visibleResourceTools(ctx, agent)).toEqual([])
      expect(renderPrompt(await ctx.systemPrompt.assemble(agent === undefined ? {} : { scope: agent })))
        .not.toContain('MCP resource servers')
      expect(await call(ctx, 'list_mcp_resources', { server: 'docs' }, agent)).toMatchObject({ isError: true })
    }
    const removeGlobal = ctx.mcpResources.register('docs', { request: globalRequest })
    removeLocal()
    expect(visibleResourceTools(ctx, child)).toEqual([...resourceToolNames].sort())
    await call(ctx, 'list_mcp_resources', { server: 'docs' }, child)
    expect(localRequest).toHaveBeenCalledTimes(2)
    expect(globalRequest).toHaveBeenCalledOnce()
    removeGlobal()
    expect(visibleResourceTools(ctx, owner)).toEqual([])
    expect(visibleResourceTools(ctx, child)).toEqual([])
    scoped.ctx.mcpResources.register('docs', { request: localRequest })
    expect(visibleResourceTools(ctx, owner)).toEqual([...resourceToolNames].sort())
    await scoped.dispose()
    expect(visibleResourceTools(ctx, owner)).toEqual([])
  })

  it('不可用的服务器名在发起任何网络操作之前失败', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    ctx.mcpResources.register('docs', { request })
    const result = await call(ctx, 'list_mcp_resources', { server: 'absent' })
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result)).toContain('is unavailable in this agent\'s scope')
    expect(request).not.toHaveBeenCalled()
  })

  it('请求失败时仍保留工具，且提示词列出可见的服务器名', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockRejectedValue(new Error('MCP server disconnected'))
    ctx.mcpResources.register('docs', { request })
    expect((await call(ctx, 'list_mcp_resources', { server: 'docs' })).isError).toBe(true)
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('server argument: ["docs"]')
  })

  it('缺少 server 参数在派发前失败，且不触碰提供方', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    ctx.mcpResources.register('docs', { request })
    expect((await call(ctx, 'list_mcp_resources', {})).isError).toBe(true)
    expect((await call(ctx, 'read_mcp_resource', { server: 'docs' })).isError).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('共享工具注册失败时回滚，不留下半个工具集', async () => {
    const ctx = await setup()
    const removeConflict = ctx.tools.register(defineTool({
      name: 'list_mcp_resource_templates', description: 'Conflicting tool.', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => null,
    }))
    expect(() => ctx.mcpResources.register('docs', { request: async () => ({ resources: [] }) }))
      .toThrow('already registered')
    expect(ctx.tools.get('list_mcp_resources')).toBeUndefined()
    removeConflict()
    // 回滚后再次注册应当成功。
    ctx.mcpResources.register('docs', { request: async () => ({ resources: [] }) })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
  })

  it('三个工具把参数透传为对应的 MCP 方法，游标与 URI 原样传递', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>()
      .mockResolvedValue({ ok: true })
    ctx.mcpResources.register('docs', { request })
    await call(ctx, 'list_mcp_resources', { server: 'docs' })
    await call(ctx, 'list_mcp_resources', { server: 'docs', cursor: 'next-page' })
    await call(ctx, 'list_mcp_resource_templates', { server: 'docs', cursor: 'tpl-cursor' })
    await call(ctx, 'read_mcp_resource', { server: 'docs', uri: 'docs://guide' })
    expect(request.mock.calls.map(entry => entry[0])).toEqual([
      { method: 'resources/list' },
      { method: 'resources/list', cursor: 'next-page' },
      { method: 'resources/templates/list', cursor: 'tpl-cursor' },
      { method: 'resources/read', uri: 'docs://guide' },
    ])
  })
})

describe('renderResourceResult', () => {
  it('把 base64 blob 换成说明文字，并把来源服务器标在文本之前', () => {
    const blocks = renderResourceResult('docs', {
      contents: [{ uri: 'docs://image', mimeType: 'image/png', blob: 'AAAAAAAA' }],
    })
    expect(blocks).toEqual([{
      type: 'text',
      text: 'MCP server: docs\n'
        + '{"contents":[{"uri":"docs://image","mimeType":"image/png",'
        + '"blob":"[binary resource: 8 base64 characters; available to programmatic callers]"}]}',
    }])
  })

  it('文本内容原样保留', () => {
    const blocks = renderResourceResult('docs', { contents: [{ uri: 'docs://readme', text: 'hello' }] })
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect((blocks[0] as { text: string }).text).toBe('MCP server: docs\n{"contents":[{"uri":"docs://readme","text":"hello"}]}')
  })
})
