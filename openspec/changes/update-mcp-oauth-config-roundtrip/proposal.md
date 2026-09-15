# 修复 MCP OAuth 配置不可达与编辑丢失

## 为什么

OAuth 支持已实现，但用户在设置页无法配置它，且编辑一个已配置 OAuth 的服务器会**静默清除其配置**。

实测证据：一个 `auth.kind === 'oauth'` 的条目经设置页编辑器往返后，编辑器只显示 `{ url, headers }`，保存回写时 `auth` 变为 `none`。用户在界面上看不到任何提示，服务器随即失去认证配置。

根因是设计阶段的决策 D6「`mcp.json` 对 OAuth 只读不写」：设置页的编辑功能建立在 `mcp.json` 往返之上，写入方向省略 OAuth 字段，编辑器就看不到它们。仓库里 `allowedTools` 已给出正确先例——同为 dsh 扩展字段，但读写对称，其他平台读到按未知字段忽略。

## 做什么

反转 D6，让 OAuth 字段读写对称：

- `settingsToMcpJson` 与 `entryToServerJson` 在条目为 OAuth 时写出 `authMode`、`clientId`、`authorizationUrl`、`tokenUrl`，以及仅在携带时的 `scopes`
- `auth.kind === 'none'` 的条目输出逐字不变，绝大多数用户的 `mcp.json` 不受影响
- 保留读方向的沉默继承规则，理由从「缓解丢配置」改述为「升级与手编兼容」
- 包 README 记录完整使用路径与字段说明

## 不做什么

- 不新增设置页 OAuth 表单控件（独立输入框 + 认证按钮）：需要新 UI 与文案，作为后续增强
- 不改变 OAuth 协议实现、令牌存储或 authorization flow 接入

## 影响

- `packages/mcp/mcp-manager`：`mcp-json.ts` 写方向
- `packages/client/ui-settings-mcp`：`mcp-server-json.ts` 编辑器渲染、`types.ts` 字段
- 文档：包 README、设计文档

`mcp.json` 是跨厂商磁盘格式，本次变更改变其输出形状（对 OAuth 条目），属 l2。
