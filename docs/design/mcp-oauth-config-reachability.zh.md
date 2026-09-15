---
description: "修复 MCP OAuth 配置在设置页不可达、且编辑保存会静默清除的缺陷：把 OAuth 字段作为 dsh 扩展对称写入 mcp.json，反转原先的只读决策。"
kind: "design-draft"
---

# 修复 MCP OAuth 配置不可达与编辑丢失

## 问题

OAuth 支持已实现并接入 `dsh-authorization` seam，但**用户在设置页无法配置它**，而且更严重的是：**编辑一个已配置 OAuth 的服务器会静默清除其配置**。

三条路径的实测结果：

| 路径 | 行为 |
|---|---|
| 页面表单控件 | 没有 OAuth 相关输入项 |
| 编辑已有 OAuth 服务器 | 编辑器不显示 OAuth 字段；保存后 `auth` 变为 `none`，配置丢失 |
| 粘贴 JSON 添加 | 可工作，但要求用户手写未文档化的 `authMode` + 端点字段 |

编辑路径的实测证据（`entryToServerJson` → `serverJsonToEntry` 往返）：

```
输入: { url, headers, auth: { kind: 'oauth', clientId, authorizationUrl, tokenUrl } }
编辑器显示: { "url": "...", "headers": {} }
保存回: { ..., auth: { kind: 'none' } }
```

## 根因

设计阶段的 **D6「`mcp.json` 对 OAuth 只读不写」** 是错的。

当时的理由是"避免把 dsh 的端点约定发布成其他平台不认的形状"。但设置页的**编辑功能建立在 `mcp.json` 往返之上**：写入方向刻意省略 OAuth 字段，编辑器就看不到它们，保存时自然丢失。这个后果在设计阶段没有被识别出来。

仓库里 `allowedTools` 已给出正确先例——它同样是 dsh 扩展字段，但**读写对称**，包 README 明确写着"同步时会读入、写回，其他平台读它时按未知字段忽略"。本设计沿用该先例。

## 决策

### D7：OAuth 字段读写对称，与 `allowedTools` 同构

`settingsToMcpJson` 与 `entryToServerJson` 在条目为 OAuth 时写出 dsh 扩展字段：

```json
{
  "url": "https://example.com/mcp",
  "authMode": "oauth",
  "clientId": "...",
  "authorizationUrl": "https://example.com/authorize",
  "tokenUrl": "https://example.com/token",
  "scopes": ["..."]
}
```

规则：

- 仅当 `auth.kind === 'oauth'` 时写出。`none` 条目的输出与本次变更前完全一致，因此绝大多数用户的 `mcp.json` 逐字不变。
- `scopes` 仅在条目携带时写出，与 `allowedTools` 的省略规则一致。
- 其他平台读到这些字段按未知字段忽略——这是 `mcp.json` 既有扩展字段的既定约定。

### D8：读方向的"沉默继承"降级为兼容措施

上一轮为缓解丢配置引入了「文档沉默时继承当前分节的 auth」。字段改为对称写出后，文档不再沉默，该规则的存在理由减弱，但仍保留：

- 它覆盖"用户手写了 `authMode: 'oauth'` 但漏了端点"这类半配置，此时**报错**而非静默降级（既有行为）。
- 它覆盖一个仍会发生的真实场景：用户从旧版本升级，`mcp.json` 是旧的（无 OAuth 字段），而 settings 已有 OAuth 条目——此时若把沉默读作 `none`，第一次手编仍会丢配置。

因此该规则从"缓解措施"变为"升级与手编兼容"，保留并在注释中改述其理由。

### D9：设置页仍不新增 OAuth 表单控件

本次只修数据丢失与可发现性缺口（README 记录完整路径 + 字段说明）。独立的 OAuth 表单控件（输入框 + 认证按钮）作为后续增强，因为它需要新的 UI 与文案，且当前"粘贴 JSON"路径在文档化之后已可用。

## 验证计划

- 编辑往返：OAuth 条目经 `entryToServerJson` → `serverJsonToEntry` 后 `auth` 完整保留。
- `mcp.json` 往返：`settingsToMcpJson` → `mcpJsonToSettings` 后 `auth` 完整保留。
- `none` 条目输出不变：断言输出中不含任何 OAuth 字段。
- 手编可配置：粘贴含 OAuth 字段的配置可成功添加。
- 端到端：设置页编辑一个 OAuth 服务器并保存后，Host 侧 `auth` 仍为 `oauth`。
