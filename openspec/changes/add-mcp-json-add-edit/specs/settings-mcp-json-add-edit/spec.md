# settings-mcp-json-add-edit

## ADDED Requirements

### Requirement: 通过 JSON 编辑器增加 MCP 服务
用户在「设置 → MCP」页 SHALL 能通过「增加MCP」按钮打开一个 JSON 编辑器粘贴跨厂商 MCP 配置，并把贴入的服务写回 `mcp.json`。

#### Scenario: 贴入含 mcpServers 包裹的配置
- **WHEN** 用户点击「增加MCP」并贴入含顶层 `mcpServers` 对象的 JSON
- **THEN** 系统 MUST 只取 `mcpServers` 内部的服务 map，忽略外层字段

#### Scenario: 贴入裸服务 map
- **WHEN** 用户贴入 `{"name": {…}}` 形式的裸服务 map
- **THEN** 系统 SHALL 接受该 map 并在保存时合并进 `mcp.json`

### Requirement: 同名服务覆盖确认
写入前系统 MUST 检测贴入的服务名是否与 `mcp.json` 中已有的原始键重名，重名时要求用户确认覆盖。

#### Scenario: 贴入名与现有服务重名
- **WHEN** 贴入的服务名与现有服务重名
- **THEN** 系统 SHALL 弹出确认框；用户同意后 MUST 用新配置替换同名服务，拒绝则 MUST 中止写入

### Requirement: 通过 JSON 编辑器编辑单服务配置
用户点击某个服务的「编辑」时，页面 SHALL 打开 JSON 编辑器展示该服务的跨厂商配置对象，保存时替换该条目。

#### Scenario: 编辑并保存单服务
- **WHEN** 用户点击「编辑」并修改该服务的 JSON 后保存
- **THEN** 系统 SHALL 用编辑后的对象替换 `mcp.json` 中该服务的条目并回写

### Requirement: 贴入配置的输入边界
系统 MUST 拒绝无法解析出「服务名 → 配置对象」映射的贴入内容并报告错误。

#### Scenario: 贴入既无 mcpServers 也非服务 map 的配置
- **WHEN** 贴入的 JSON 既不含 `mcpServers` 也不是「名字 → 对象」map
- **THEN** 系统 SHALL 报告错误并拒绝写入