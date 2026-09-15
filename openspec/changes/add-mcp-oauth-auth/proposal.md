# 为内置 MCP 管理增加 OAuth 认证

## 为什么

内置 `dsh-mcp-manager` 只支持以静态 `headers` 承载凭据（见 `packages/mcp/mcp-client/src/transport.ts`，HTTP 传输仅透传配置中的 headers）。需要浏览器登录的 MCP 服务器因此无法在内置设置页中完成授权，用户要么退回手工填写令牌，要么引入外部插件 `dsh-mcp-manager`（hyqhyq3）——而后者与内置实现并存，会产生两个设置入口、两份互不相通的服务器列表，并共用会冲突的 `mcp__<name>__` 工具前缀。

本次变更把 OAuth（授权码 + PKCE）能力内置，使内置设置页成为唯一的 MCP 管理入口。

## 做什么

在 `mcp` settings 命名空间的 HTTP 服务器条目上增加 `auth` 判别联合，并把授权令牌托管给已有的凭据 seam：

- `auth` 支持 `none`（默认）与 `oauth`（预配置 client_id + PKCE）两项
- 令牌与刷新令牌存为 `GrantRecord`，经 `CredentialProvider.modifyRecord()` 读写，不进 settings 文档
- 授权回调挂在 `dsh-host-webserver` 的路由上；无 webserver 的 profile 优雅降级
- 新增 `needs-auth` 连接状态，与 `failed` 并列，判别点是"用户动作能否修复"
- 浏览器设置页新增"去认证"按钮与 `needs-auth` 状态徽章

## 不做什么

- 不做 `static` 静态令牌模式：静态 Bearer 继续用现有 `headers` 字段
- 不做 RFC 7591 动态客户端注册：只支持预配置 `client_id`
- `mcp.json` 对 OAuth 只读不写：可识别，不渲染
- 不改 stdio 服务器的配置形状
- 不做工作区级 MCP 配置与 on-demand 工具 broker（各自独立评估）

## 影响

- `packages/mcp/mcp-manager`：`auth` schema、GrantRecord 读写、OAuth 流程、Remote 方法、状态机扩展
- `packages/mcp/mcp-client`：HTTP transport 前解析凭据、401 触发刷新、`needs-auth` 上报
- `packages/client/ui-settings-mcp`：`needs-auth` 徽章、"去认证"按钮、locale 文案
- `packages/credentials/credentials`：无改动，复用现有 `GrantRecord`

`mcp` settings 命名空间是持久化 schema，本次变更属于结构契约变更（l2）。
