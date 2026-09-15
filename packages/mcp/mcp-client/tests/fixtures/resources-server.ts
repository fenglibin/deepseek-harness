/**
 * 确定性的 MCP 资源与字面量 instructions，供 headless 会话快照与资源用例复用。
 *
 * 用本地 v1 SDK 的 `McpServer` + `StdioServerTransport` 形状书写。
 * Run: node --import tsx/esm resources-server.ts
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

/** instructions 里刻意保留 `{{braces}}`，用于验证段落以字面量注入而不被插值。 */
const INSTRUCTIONS = 'MCP_RESOURCE_INSTRUCTION: keep {{braces}} literal. Read resources from the catalog server.'

/** base64 的 `mcp-resource-binary`，供二进制渲染断言使用。 */
export const BINARY_BASE64 = 'bWNwLXJlc291cmNlLWJpbmFyeQ=='

/**
 * 构建该 fixture 服务器，注册一个文本资源、一个二进制资源与一个 URI 模板。
 * @returns 已注册全部资源的服务器实例。
 */
export function createResourcesServer(): McpServer {
  const server = new McpServer(
    { name: 'snapshot-resources', version: '1.0.0' },
    { capabilities: { resources: {}, tools: {} }, instructions: INSTRUCTIONS },
  )
  // 本地 v1 SDK 只在 `registerTool` 时才注册 `tools/list` 处理器，而 `mcp-client`
  // 建连时会调它做首次同步。注册一个纯粹用于让该能力可应答的工具，使本 fixture
  // 专注于资源能力（该工具不是本测试的断言对象）。
  server.registerTool('resource_catalog_ping', {
    description: 'Placeholder tool so the server answers tools/list; not asserted by these tests.',
    inputSchema: {},
  }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  server.registerResource('memo', 'memo://text', {
    description: 'Deterministic text memo.',
    mimeType: 'text/plain',
  }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'MCP resource text with {{braces}} intact.' }],
  }))
  server.registerResource('binary', 'memo://binary', {
    description: 'Binary content for programmatic callers.',
    mimeType: 'application/octet-stream',
  }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/octet-stream', blob: BINARY_BASE64 }],
  }))
  // 模板必须用 `ResourceTemplate` 实例注册：传字符串会被当作静态 URI，
  // `resources/templates/list` 因而不会列出它。
  server.registerResource(
    'greeting',
    new ResourceTemplate('memo://greeting/{name}', { list: undefined }),
    { description: 'A greeting for the named reader.', mimeType: 'text/plain' },
    async (uri, variables) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Hello, ${String(variables.name)}.` }],
    }),
  )
  return server
}

// `import.meta.main` 在 `node --import tsx/esm <file>` 下是 undefined（tsx 的
// ESM hook 不合成它），因此按 argv[1] 判断本文件是否是被执行的脚本：spec 会
// 把本模块当普通模块导入以复用 BINARY_BASE64，此时绝不能连上 stdio。
const invokedAsScript = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedAsScript) {
  await createResourcesServer().connect(new StdioServerTransport())
}
