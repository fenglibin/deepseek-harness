# 增加 MCP 的 JSON 化增加/编辑

## 为什么

MCP 设置页目前只有"配置MCP"（编辑整份 mcp.json）和表单式"编辑"（结构化字段对话框），缺少"增加"入口；用户只能先打开整份 mcp.json 手工粘贴新服务。编辑与配置两条路径视觉不统一。

## 改什么

1. 在"配置MCP"按钮左侧新增"增加MCP"按钮：弹出 JSON 编辑器，用户贴入 MCP 配置（兼容 `{"mcpServers":{…}}` 包裹，自动剥离取内部），写入 mcp.json。
2. 同名校验：写入前检测贴入的服务器名与现有服务是否重名，重名则弹确认框，同意后覆盖。
3. "编辑"改为 JSON 编辑器展示该服务配置，保存回写 mcp.json，与增加流程视觉统一。
4. 移除表单式 `McpServerDialog`。

## 影响

- 新增纯函数模块 `mcp-server-json.ts`（JSON 形状转换，纯前端）。
- 改造 `McpSection.tsx`、`McpJsonEditor.tsx`、`mcp-document-store.ts`、`locales.ts`。
- 删除 `McpServerDialog.tsx`/`.module.css`。
- 更新 `tests/` 与快照。