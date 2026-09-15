/** Chinese strings. */
export const zh = {
  nav: 'MCP',
  title: 'MCP 服务器',
  intro: '管理模型可以调用工具的 MCP 服务器。',
  configure: '配置MCP',
  addMCP: '增加MCP',
  edit: '编辑',
  remove: '删除',
  close: '关闭',
  cancel: '取消',
  save: '保存',
  saving: '保存中…',
  format: '格式化',
  editorTitle: '编辑 mcp.json',
  addServerTitle: '增加 MCP 服务器',
  editTitle: '编辑 {server}',
  invalidJson: 'JSON 语法错误',
  saveFailed: '保存失败',
  addInvalid: '无法解析贴入的 MCP 配置，请确认包含服务器名或 mcpServers 包裹。',
  overwriteTitle: '覆盖已有服务器？',
  overwriteDescription: '以下服务器已存在，覆盖将替换其配置：{servers}',
  overwriteConfirm: '覆盖',
  readOnly: '当前部署的设置文档为只读。',
  empty: '尚未配置任何 MCP 服务器。',
  transportStdio: 'stdio',
  transportStreamableHttp: 'streamable-http',
  deleteTitle: '删除 {server}？',
  deleteDescription: '删除 {server} 会移除其配置。',
  deleteConfirm: '删除 {server}',
  deleting: '正在删除 {server}…',
  saved: '已保存 {server}。',
  failed: '更改未能保存。',
  refresh: '刷新',
  toolsCount: '{count} 个工具',
  expandTools: '展开工具',
  collapseTools: '收起工具',
  noTools: '暂无可用工具',
  statusNeedsAuth: '需要授权',
  authenticate: '去认证',
  authenticating: '正在打开授权页…',
  authFailed: '无法发起授权：{error}',
  // Editor guidance: a one-line reminder beside the editor, and a help dialog
  // carrying the examples. Both live here because every product-visible string
  // in this package is locale-owned.
  // The sentence ends where the help link begins, and both render on one line:
  // the copy must not also say "see help" or the line would say it twice.
  editorHint: '粘贴跨厂商 MCP 配置即可添加服务器；需要浏览器登录的服务器要填写 authMode 与端点。',
  help: '帮助',
  helpTitle: 'MCP 配置帮助',
  helpIntro: '每个服务器是一个 JSON 对象，键为服务器名（字母、数字、- 与 _，至多 32 字符），它决定模型看到的工具名前缀 mcp__<服务器名>__。粘贴时可省略 mcpServers 包裹。',
  helpBasicHeading: '基础配置',
  helpBasicStdioLabel: 'stdio（本地进程）',
  helpBasicStdioNote: '由 harness 启动一个本地进程，通过标准输入输出通信。',
  helpBasicStdioExample: `{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
  }
}`,
  helpBasicHttpLabel: 'streamable-http（远程端点）',
  helpBasicHttpNote: '连接一个远程 HTTP 端点；需要凭据时用 headers，或用下方 OAuth 配置。',
  helpBasicHttpExample: `{
  "remote": {
    "url": "https://example.com/mcp",
    "headers": { "X-Api-Key": "your-key" }
  }
}`,
  helpOAuthHeading: 'OAuth 服务器',
  helpOAuthNote: '需要浏览器登录的服务器填写 authMode 与三项端点信息，它们由服务器提供方给出；本包不做服务端发现，也不做动态客户端注册。',
  helpOAuthExample: `{
  "remote": {
    "url": "https://example.com/mcp",
    "authMode": "oauth",
    "clientId": "your-client-id",
    "authorizationUrl": "https://example.com/authorize",
    "tokenUrl": "https://example.com/token",
    "scopes": ["mcp:read"]
  }
}`,
  helpOAuthSteps: '保存后该服务器显示为「需要授权」，点行内的「去认证」在浏览器中登录；授权完成后会自动重连，状态变为「已连接」，其工具随即可用。令牌保存在凭据存储中，不写入设置文件。',
  helpOptionalHeading: '可选字段',
  helpOptionalNote: '下列字段均可省略。allowedTools 只注册名单内的工具，用于收窄模型可见的工具集；env 传给 stdio 子进程，headers 附加到每次 HTTP 请求；cwd 指定 stdio 子进程的工作目录。',
  helpOptionalExample: `{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    "env": { "LOG_LEVEL": "info" },
    "cwd": "/path/to/workspace",
    "allowedTools": ["read_file", "write_file"]
  }
}`,
  helpFileNote: '这些配置同时保存在设置文档旁的 mcp.json 中，两种入口等价：在设置页保存会写回该文件，直接编辑该文件也会被读取。',
} satisfies Record<string, string>

/** The settings.mcp namespace key union. */
export type McpKey = keyof typeof zh
