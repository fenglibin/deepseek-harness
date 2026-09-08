# 实现清单

- [ ] 新增 `mcp-server-json.ts`：`parsePastedServers`（剥离 mcpServers 包裹）、`entryToServerJson`（entry→跨厂商 JSON）、`mergeServerText`、`replaceServerText`、`extractServerNames` (covers: settings-mcp-json-add-edit/通过 JSON 编辑器增加一个 MCP 服务, settings-mcp-json-add-edit/通过 JSON 编辑器编辑单服务配置, design/D3)
- [ ] `McpJsonEditor` 新增 `title?` prop（默认 `editorTitle`） (covers: design/D5)
- [ ] `McpSection` 新增"增加MCP"按钮（配置MCP 左侧），打开空 JSON 编辑器 (covers: settings-mcp-json-add-edit/通过 JSON 编辑器增加一个 MCP 服务, design/D5)
- [ ] `McpSection` 增加保存路径：解析贴入 JSON → 同名检测 → 覆盖确认 Modal → 合并回写 (covers: settings-mcp-json-add-edit/同名服务覆盖确认, settings-mcp-json-add-edit/贴入既无 mcpServers 也非服务 map 的配置, design/D4)
- [ ] `McpSection` 编辑改用 JSON 编辑器：`entryToServerJson` 初始文本 → 替换回写 (covers: settings-mcp-json-add-edit/通过 JSON 编辑器编辑单服务配置, design/D2)
- [ ] 删除 `McpServerDialog.tsx`/`.module.css` 及 `McpStore.update` 表单路径 (covers: design/D6)
- [ ] 更新 `locales.ts` 文案（增加、编辑标题、覆盖确认、报错） (covers: design/D4, design/D5)
- [ ] 更新/新增单测与快照 (covers: settings-mcp-json-add-edit/同名服务覆盖确认, settings-mcp-json-add-edit/贴入既无 mcpServers 也非服务 map 的配置)