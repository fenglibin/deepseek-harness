# mcp-server-auth 规范增量

## MODIFIED Requirements

### Requirement: mcp.json 与设置页对 OAuth 配置读写对称

`mcp.json` SHALL 携带 dsh 的 OAuth 扩展字段，且设置页编辑器 SHALL 显示并保留它们。渲染一个 `auth.kind === 'oauth'` 的条目时 SHALL 写出 `authMode`、`clientId`、`authorizationUrl` 与 `tokenUrl`，并在条目携带 `scopes` 时写出 `scopes`。

渲染一个 `auth.kind === 'none'` 的条目时 SHALL NOT 写出任何 OAuth 字段，其输出与不含本能力时逐字相同。

#### Scenario: 编辑一个 OAuth 服务器不丢失其配置

- **WHEN** 设置页编辑器打开一个 `auth.kind === 'oauth'` 的服务器
- **THEN** 编辑器 SHALL 显示 `authMode`、`clientId`、`authorizationUrl` 与 `tokenUrl`
- **AND** 保存后该条目的 auth SHALL 仍为 `oauth`
- **AND** 其 `clientId`、`authorizationUrl` 与 `tokenUrl` SHALL 与编辑前相同

#### Scenario: 渲染 mcp.json 携带 OAuth 细节

- **WHEN** settings 中含一个 OAuth 服务器
- **THEN** 渲染出的 `mcp.json` SHALL 包含 `authMode: "oauth"` 与三个端点字段

#### Scenario: none 条目的输出不受影响

- **WHEN** settings 中含一个 `auth.kind === 'none'` 的条目
- **THEN** 渲染出的 `mcp.json` SHALL NOT 包含 `authMode`、`clientId`、`authorizationUrl`、`tokenUrl` 或 `scopes`

#### Scenario: 手编 mcp.json 可配置 OAuth

- **WHEN** 用户向 `mcp.json` 写入一个含 `authMode: "oauth"` 与三个端点字段的条目
- **THEN** 同步后 settings 中该条目的 auth SHALL 为 `oauth`
- **AND** 该服务器 SHALL 可被授权

#### Scenario: 完整往返保留 OAuth 配置

- **WHEN** 一个 OAuth 条目经渲染为 `mcp.json` 再同步回 settings
- **THEN** 其 auth SHALL 与往返前逐字段相同

## RETAINED Requirements

### Requirement: 半配置的 OAuth 条目被拒绝

条目指明 OAuth 却缺少 `clientId`、`authorizationUrl` 或 `tokenUrl` 之一时 SHALL 报错，而非静默降级为 `none`，使半配置的服务器不会看起来像一个可用的 OAuth 服务器。

#### Scenario: 缺端点的 OAuth 条目报错

- **WHEN** `mcp.json` 中一个条目含 `authMode: "oauth"` 但缺少 `tokenUrl`
- **THEN** 该次同步 SHALL 被拒绝并记录诊断
- **AND** settings SHALL 保留最后一份有效分节

### Requirement: 文档沉默时继承当前分节

`mcp.json` 的一个条目未指明认证方式时，SHALL 继承当前 settings 分节中同名条目已有的 auth；仅当无既有 OAuth 状态时 SHALL 解析为 `none`。该规则覆盖旧版本写下的文档（无 OAuth 字段）与手编场景，使首次手编不会清空已有 OAuth 配置。

#### Scenario: 旧文档首次手编不清空 OAuth

- **WHEN** settings 中一个条目为 `auth.kind === 'oauth'`，而 `mcp.json` 中对应条目不含任何 OAuth 字段
- **AND** 用户在该文档中新增一个无关服务器
- **THEN** 同步后原条目的 auth SHALL 仍为 `oauth`
