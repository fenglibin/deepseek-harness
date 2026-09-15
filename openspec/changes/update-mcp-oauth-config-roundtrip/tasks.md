# 实施清单

## 1. Host 侧写方向

- [x] 1.1 `settingsToMcpJson` 在 `auth.kind === 'oauth'` 时写出 `authMode`、`clientId`、`authorizationUrl`、`tokenUrl` (covers: mcp-server-auth/渲染 mcp.json 携带 OAuth 细节, design/D7)
- [x] 1.2 `scopes` 仅在条目携带时写出，与 `allowedTools` 的省略规则一致 (covers: mcp-server-auth/渲染 mcp.json 携带 OAuth 细节, design/D7)
- [x] 1.3 确认 `none` 条目输出逐字不变，并补断言 (covers: mcp-server-auth/none 条目的输出不受影响, design/D7)

## 2. Client 侧编辑器渲染

- [x] 2.1 `entryToServerJson` 对 OAuth 条目输出同样的字段，使编辑器显示它们 (covers: mcp-server-auth/编辑一个 OAuth 服务器不丢失其配置, design/D7)
- [x] 2.2 `types.ts` 的 `McpJsonServer` 确认已含这些字段（读方向已有），补 `scopes` 渲染 (covers: mcp-server-auth/编辑一个 OAuth 服务器不丢失其配置, design/D7)

## 3. 读方向兼容

- [x] 3.1 把「沉默继承」的注释与文档理由改述为升级与手编兼容 (covers: mcp-server-auth/文档沉默时继承当前分节, design/D8)
- [x] 3.2 确认半配置仍报错而非静默降级 (covers: mcp-server-auth/半配置的 OAuth 条目被拒绝, design/D8)

## 4. 测试

- [x] 4.1 单测：`mcp.json` 完整往返保留 OAuth 配置逐字段相同 (covers: mcp-server-auth/完整往返保留 OAuth 配置, design/D7)
- [x] 4.2 单测：`none` 条目渲染输出不含任何 OAuth 字段 (covers: mcp-server-auth/none 条目的输出不受影响, design/D7)
- [x] 4.3 单测：编辑器往返（`entryToServerJson` → `serverJsonToEntry`）保留 OAuth (covers: mcp-server-auth/编辑一个 OAuth 服务器不丢失其配置, design/D7)
- [x] 4.4 单测：粘贴含 OAuth 字段的配置可添加该服务器 (covers: mcp-server-auth/手编 mcp.json 可配置 OAuth, design/D7)
- [x] 4.5 组件测试：设置页编辑一个 OAuth 服务器并保存后，提交给 Host 的条目 auth 仍为 `oauth` (covers: mcp-server-auth/编辑一个 OAuth 服务器不丢失其配置, design/D7)
- [x] 4.6 单测：旧文档首次手编不清空已有 OAuth 配置 (covers: mcp-server-auth/文档沉默时继承当前分节, design/D8)

## 5. 文档

- [x] 5.1 包 README 记录完整使用路径（如何配置 OAuth 服务器）与字段说明 (covers: design/D9)
- [x] 5.2 更新设计文档与 Agent Note，把 D6 改述为 D7 并记录反转理由 (covers: design/D7)
