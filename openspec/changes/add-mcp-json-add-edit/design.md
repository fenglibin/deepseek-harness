# 技术设计

### D1 纯前端实现，复用 `writeMcpDocument`
Host `writeMcpDocument(text)` 已含"parseMcpJson + mcpJsonToSettings 校验 + writeFile + syncMcpJson"。前端合并/替换单条后交回该 RPC，无需新增 Host 方法。

### D2 单服务 JSON 用 `McpJsonServer` 形状
编辑器文本为跨厂商形状（`command`/`url`/`args`/`env`/`headers`/`cwd`/`disabled`）。`enabled=false` 渲染为 `disabled:true`。serverName/transport 由上下文确定。

### D3 新增纯函数模块 `mcp-server-json.ts`
`parsePastedServers`、`entryToServerJson`、`mergeServerText`、`replaceServerText`、`extractServerNames`，无 React/ctx 依赖，便于单测。

### D4 同名覆盖确认在前端保存路径完成
`extractServerNames` 与 `state.servers` 比对，交集弹 Modal 确认，同意覆盖。

### D5 复用 `McpJsonEditor`，新增 `title?` prop
增加=空文本+增加标题；编辑=单服务文本+编辑标题；配置=整份 mcp.json 不变。

### D6 移除 `McpServerDialog`
统一为 JSON 编辑器后删除表单对话框及其 css。