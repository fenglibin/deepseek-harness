# Agent Note: MCP 设置分区「增加MCP」与 JSON 化「编辑」

Status: implemented

## 问题

MCP 设置分区只有「配置MCP」（编辑整份 `mcp.json`）和结构化表单「编辑」，没有独立的「增加」入口：新增一个服务器必须先打开整份 `mcp.json` 手工粘贴。三条路径视觉不统一——增加与编辑走表单、配置走 JSON 编辑器，用户在两套交互之间切换。

## 决策

1. 新增「增加MCP」按钮（在「配置MCP」左侧），打开复用的 JSON 编辑器（空初始文本），用户粘贴跨厂商 MCP 配置。保存时纯函数 `parsePastedServers` 剥离可选的 `{"mcpServers":{…}}` 包裹、只取内部，得到「原始名 → 服务器对象」map；与当前 `mcp.json` 的原始键比对，存在同名则弹 Modal 确认覆盖，同意后合并写回（`writeMcpDocument`）。
2. 「编辑」改为 JSON 编辑器：`entryToServerJson` 把 `McpServerEntry` 渲染成跨厂商对象（`enabled:false` 映射为 `disabled:true`，`cwd` 为空时省略），用户编辑后 `serverJsonToEntry` 转回 entry，经既有 `updateMcpServer` 替换。
3. 移除表单式 `McpServerDialog`。增加与编辑统一为同一个 JSON 编辑器，视觉一致。
4. 同名检测用 `mcp.json` 的原始键（`parseDocument`），而非 settings 里已 sanitize 的 `serverName`，因此非契约名（CJK，后端会哈希成 `mcp-<hex>`）也能正确检出同名；合并用原始键写入，后端 `sanitizeServerName` 负责哈希。

## 考虑过的替代方案

- 新增 Host `addMcpServer`/`upsertMcpServer` RPC——否决；`writeMcpDocument` 已是完整的「校验 + 持久化 + 立即同步」路径，前端合并后交回即可，无需扩 RPC 面。
- 编辑走 `writeMcpDocument` 整份替换——否决；会丢失非契约名的原始键映射（settings 里只有哈希后的名字），而 `updateMcpServer` 已内建该映射，复用更稳。
- 同名检测用 settings 的 sanitize `serverName`——否决；非契约名会被哈希，与贴入的原始名对不上而漏检同名。

## 后果

- 增加、编辑、配置三条路径共用同一个 `McpJsonEditor`，标题与初始文本经 `title` prop 与传入文本区分。
- 新增纯函数模块 `mcp-server-json.ts`（无 React/ctx），承载解析、包裹剥离、合并、渲染、entry↔跨厂商对象转换，全部可独立单测。
- `McpServerDialog.tsx` 及其样式、17 个表单专属 locale 键被删除。

## 风险

- 编辑保存把 JSON 转回 entry 再走 `updateMcpServer`，因此用户编辑时若删掉 `disabled` 字段，等价于启用（`disabled !== true`）；这是跨厂商格式的既有语义。
- 增加时贴入既无 `mcpServers` 也非「名字 → 对象」map 的裸对象（如 `{"command":"…"}`）会被拒绝并提示 `addInvalid`，用户需补上服务器名。