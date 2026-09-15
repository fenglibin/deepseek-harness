# mcp-server-auth 规范增量

## ADDED Requirements

### Requirement: HTTP 服务器条目支持 auth 判别联合

`mcp` settings 命名空间中 `transport` 为 `streamable-http` 的条目 SHALL 支持可选的 `auth` 字段，取值为 `none` 或 `oauth` 的判别联合。省略 `auth` 时 MUST 按 `none` 解析。

`transport` 为 `stdio` 的条目 SHALL NOT 接受 `auth` 字段。

#### Scenario: 省略 auth 的条目按 none 解析

- **WHEN** 一个 HTTP 条目不含 `auth` 字段
- **THEN** 该条目的 auth SHALL 解析为 `{ kind: 'none' }`
- **AND** 其 connection 行为与本次变更前完全一致

#### Scenario: 已有条目无需迁移

- **WHEN** 升级后加载变更前的 settings 文档
- **THEN** 每个已有 HTTP 条目 SHALL 成功解析
- **AND** 其 auth SHALL 为 `none`

#### Scenario: stdio 条目拒绝 auth 字段

- **WHEN** 一个 stdio 条目携带 `auth` 字段
- **THEN** 该 settings 分节 SHALL 在写入前被拒绝

### Requirement: OAuth 授权流程

配置 `auth: { kind: 'oauth' }` 的服务器 SHALL 支持授权码 + PKCE 流程，使用条目中预配置的 `clientId`。令牌由 Host 侧获取并持久化，浏览器半身 MUST NOT 接触令牌。

#### Scenario: 未授权的服务器上报 needs-auth

- **WHEN** 一个 OAuth 服务器被挂载且不存在有效 grant
- **THEN** 其状态 SHALL 上报为 `needs-auth`
- **AND** 诊断文本 SHALL 说明该服务器需要授权

#### Scenario: 完成授权后自动连接

- **WHEN** 用户经设置页发起认证并完成服务端同意
- **THEN** Host SHALL 用授权码换取令牌并写入该服务器的 grant
- **AND** SHALL 重新挂载该服务器
- **AND** 连接成功后状态 SHALL 变为 `connected`

#### Scenario: 已有 grant 的服务器无需重复授权

- **WHEN** 一个 OAuth 服务器存在有效 grant
- **THEN** 它 SHALL 直接连接，不进入 `needs-auth`

### Requirement: 令牌持久化与轮转

OAuth 令牌 SHALL 存为该服务器的 `GrantRecord`，经 `CredentialProvider` 读写。令牌 MUST NOT 进入 settings 文档，也 MUST NOT 参与 `mcp.json` 同步。

#### Scenario: 令牌不落 settings 文档

- **WHEN** 一次 OAuth 授权完成
- **THEN** settings 文档中该条目 SHALL 不含任何令牌字段
- **AND** `mcp.json` 中 SHALL 不含任何令牌字段

#### Scenario: 401 触发刷新且不重试风暴

- **WHEN** MCP 服务器对一次请求返回 401
- **THEN** 客户端 SHALL 用 refresh token 换取新令牌并重试该请求一次
- **AND** 刷新后的令牌 SHALL 通过 `modifyRecord` 排他写入
- **AND** 刷新失败 SHALL 使该服务器进入 `needs-auth`
- **AND** SHALL NOT 在同一 outage 内重复尝试刷新

### Requirement: 无 webserver 时的降级

当 `webServer` 服务不存在时（headless / tui profile），OAuth 相关的浏览器跳转 SHALL 不可用，但 MCP 管理的其余行为 MUST 保持可用。

#### Scenario: 无 webserver 时已授权服务器照常连接

- **WHEN** 一个 OAuth 服务器存在有效 grant 且 profile 无 webserver
- **THEN** 该服务器 SHALL 正常连接并注册工具

#### Scenario: 无 webserver 时无法发起新授权

- **WHEN** 一个 OAuth 服务器需要授权且 profile 无 webserver
- **THEN** 其状态 SHALL 为 `needs-auth`
- **AND** 诊断文本 SHALL 说明当前 profile 无法完成浏览器授权
- **AND** 该插件 SHALL NOT 加载失败

### Requirement: needs-auth 状态的呈现

`McpServerStatusKind` SHALL 包含 `needs-auth`。设置页 SHALL 为 `needs-auth` 服务器显示区别性的状态标记，并提供"去认证"入口。

#### Scenario: 设置页显示 needs-auth 与认证入口

- **WHEN** 一个服务器上报 `needs-auth`
- **THEN** 设置页 SHALL 显示该状态
- **AND** SHALL 提供发起认证的入口

#### Scenario: 认证入口在无 webserver 时不误导

- **WHEN** 一个服务器因缺少 webserver 而处于 `needs-auth`
- **THEN** 设置页 SHALL 呈现该状态而不提供无法完成的认证入口

### Requirement: mcp.json 对 OAuth 只读不写

从 `mcp.json` 同步时 SHALL 识别 OAuth 服务器条目；渲染 `mcp.json` 时 SHALL NOT 输出 OAuth 细节。

#### Scenario: 从 mcp.json 识别 OAuth 服务器

- **WHEN** `mcp.json` 中一个条目指示该服务器使用 OAuth
- **THEN** 同步后 settings 中该条目 SHALL 的 auth 为 `oauth`

#### Scenario: 渲染 mcp.json 不含 OAuth 细节

- **WHEN** settings 中含一个 OAuth 服务器
- **THEN** 渲染出的 `mcp.json` SHALL NOT 包含 OAuth 专属字段
