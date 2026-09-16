/**
 * 确定性 MCP 资源服务器，供 `snapshots/session/mcp-resources` 场景使用。
 *
 * 刻意**不依赖任何 npm 包**：裸标识符解析是从导入文件自身所在目录向上走的，
 * 若这里 `import '@modelcontextprotocol/sdk'`，快照就会隐式耦合
 * `packages/mcp/mcp-client` 的依赖树——那个包的依赖一变快照即断。因此这里按 MCP
 * 的 stdio 帧格式（每行一条 JSON-RPC 消息，`ReadBuffer.readMessage()` 只按 `\n`
 * 分帧）实现最小服务器，只提供该场景需要的那几个方法。
 *
 * 提供：文本资源 `memo://text`、二进制资源 `memo://binary`、URI 模板
 * `memo://greeting/{name}`，以及含字面量花括号的 `instructions`（用于验证
 * 段落以 `interpolate: false` 注入）。
 * 另注册一个占位工具：`mcp-client` 建连时会调 `tools/list` 做首次同步，
 * 只有注册过工具的服务器才能应答它。
 */

const INSTRUCTIONS = 'MCP_RESOURCE_INSTRUCTION: keep {{braces}} literal. Read resources from the catalog server.'

/** base64 的 `mcp-resource-binary`。 */
const BINARY_BASE64 = 'bWNwLXJlc291cmNlLWJpbmFyeQ=='

const RESOURCES = [
  { uri: 'memo://text', name: 'memo', description: 'Deterministic text memo.', mimeType: 'text/plain' },
  { uri: 'memo://binary', name: 'binary', description: 'Binary content for programmatic callers.', mimeType: 'application/octet-stream' },
]

const TEMPLATES = [
  { uriTemplate: 'memo://greeting/{name}', name: 'greeting', description: 'A greeting for the named reader.', mimeType: 'text/plain' },
]

/**
 * 应答一次 JSON-RPC 请求。
 * @param method - 请求方法名。
 * @param params - 请求参数。
 * @returns 结果载荷；返回 undefined 表示该方法在本服务器上不存在。
 */
function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { resources: {}, tools: {} },
        serverInfo: { name: 'snapshot-resources', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      }
    case 'notifications/initialized':
      return undefined
    case 'tools/list':
      return {
        tools: [{
          name: 'resource_catalog_ping',
          description: 'Placeholder tool so the server answers tools/list; not asserted by this scenario.',
          inputSchema: { type: 'object', properties: {} },
        }],
      }
    case 'resources/list':
      return { resources: RESOURCES }
    case 'resources/templates/list':
      return { resourceTemplates: TEMPLATES }
    case 'resources/read': {
      const uri = String(params?.uri ?? '')
      if (uri === 'memo://text') {
        return { contents: [{ uri, mimeType: 'text/plain', text: 'MCP resource text with {{braces}} intact.' }] }
      }
      if (uri === 'memo://binary') {
        return { contents: [{ uri, mimeType: 'application/octet-stream', blob: BINARY_BASE64 }] }
      }
      const greeting = /^memo:\/\/greeting\/(.+)$/.exec(uri)
      if (greeting !== null) {
        return { contents: [{ uri, mimeType: 'text/plain', text: `Hello, ${greeting[1]}.` }] }
      }
      return undefined
    }
    default:
      return undefined
  }
}

let buffer = ''

/** 处理累积缓冲区里所有完整的行（每行一条 JSON-RPC 消息）。 */
function drain() {
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    const line = buffer.slice(0, newline).replace(/\r$/, '')
    buffer = buffer.slice(newline + 1)
    if (line.trim() === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    // 通知没有 id，不应答。
    if (message.id === undefined) continue
    const result = handle(message.method, message.params)
    const payload = result === undefined
      ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
      : { jsonrpc: '2.0', id: message.id, result }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  drain()
})
process.stdin.on('end', () => { process.exit(0) })
