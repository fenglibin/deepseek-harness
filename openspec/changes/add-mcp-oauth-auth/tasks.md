# 实施清单

## 1. settings schema

- [x] 1.1 在 `packages/mcp/mcp-manager/src/config.ts` 定义 `McpHttpAuth` 判别联合（`none` | `oauth`），含 `clientId`、`authorizationUrl`、`tokenUrl` 与可选 `scopes` (covers: mcp-server-auth/HTTP 服务器条目支持 auth 判别联合, design/D1)
- [x] 1.2 将 `auth` 加入 `HttpServerSchema`，缺省解析为 `none`；`StdioServerSchema` 不变 (covers: mcp-server-auth/省略 auth 的条目按 none 解析, mcp-server-auth/已有条目无需迁移, design/D1)
- [x] 1.3 补充 stdio 条目携带 `auth` 时被拒绝的用例与 validate 钩子路径 (covers: mcp-server-auth/stdio 条目拒绝 auth 字段, design/D1)

## 2. 凭据归属

- [x] 2.1 用 `credentialKey('mcp-oauth', serverName)` 派生 grant key，定义 grant payload 类型（access/refresh/过期/scope） (covers: mcp-server-auth/令牌不落 settings 文档, design/D2)
- [x] 2.2 实现 grant 的读写封装：读取经 `readRecord`，写入经 `modifyRecord`（排他读-改-写） (covers: mcp-server-auth/令牌不落 settings 文档, design/D2)
- [x] 2.3 注入 `credentials` 为可选服务：无凭据 provider 时 OAuth 服务器降级为 `failed` 并说明原因，而非加载失败 (covers: mcp-server-auth/无 webserver 时无法发起新授权, design/D4)

## 3. mcp-client 侧连接与刷新

- [x] 3.1 在构造 Client 与 HTTP transport 之前解析 grant，把 access token 注入请求 `Authorization` 头 (covers: mcp-server-auth/已有 grant 的服务器无需重复授权, design/D2)
- [x] 3.2 无有效 grant 时报 `needs-auth` 而非 `failed`，诊断文本说明需要授权，且不建 transport、不进入重连退避 (covers: mcp-server-auth/未授权的服务器上报 needs-auth, design/D3)
- [x] 3.3 连接被 401 拒绝时强制换发一次 token 并重试；换发被拒转 `needs-auth`；每次 outage 至多一次强制换发，非 401 不换发 (covers: mcp-server-auth/401 触发刷新且不重试风暴, design/D2)
- [x] 3.4 扩展 `McpConnectionStatus` 与 `McpServerStatusKind` 纳入 `needs-auth` (covers: mcp-server-auth/needs-auth 状态的呈现, design/D3)

## 4. OAuth 流程与回调

- [x] 4.1 生成 PKCE code_verifier / code_challenge 与 state，构造授权 URL (covers: mcp-server-auth/OAuth 授权流程, design/D5)
- [x] 4.2 经 `ctx.get('webServer')` 惰性注册回调路由；缺失时不注册且 start 报明原因、不抛错 (covers: mcp-server-auth/无 webserver 时无法发起新授权, design/D4)
- [x] 4.3 回调处理器校验 state 与 TTL、用 code 换 token、写 grant、触发重连 (covers: mcp-server-auth/完成授权后自动连接, design/D5)
- [x] 4.4 暴露 Host Remote 方法 `startAuth` 供浏览器发起认证（只返回授权 URL，不返回任何令牌） (covers: mcp-server-auth/OAuth 授权流程, design/D5)

## 5. mcp.json 往返

- [x] 5.1 读方向：`mcpJsonToSettings` 识别 OAuth 条目并转换为 `auth: { kind: 'oauth' }`，缺端点则报错 (covers: mcp-server-auth/从 mcp.json 识别 OAuth 服务器, design/D6)
- [x] 5.2 写方向：`settingsToMcpJson` 不渲染 OAuth 细节 (covers: mcp-server-auth/渲染 mcp.json 不含 OAuth 细节, design/D6)

## 6. 浏览器设置页

- [x] 6.1 `McpStatusStore` 与 `statusDot` 映射纳入 `needs-auth`，并让其不参与进入分区时的自动重连 (covers: mcp-server-auth/设置页显示 needs-auth 与认证入口, design/D3)
- [x] 6.2 为 `needs-auth` 服务器渲染「去认证」入口，经 Host Remote 方法打开授权页 (covers: mcp-server-auth/设置页显示 needs-auth 与认证入口, design/D5)
- [x] 6.3 无 webserver 时呈现状态，start 失败经错误提示呈现而不提供无法完成的跳转 (covers: mcp-server-auth/认证入口在无 webserver 时不误导, design/D4)
- [x] 6.4 补充 locale 文案（`settings.mcp` 命名空间） (covers: mcp-server-auth/设置页显示 needs-auth 与认证入口)

## 7. 测试与文档

- [x] 7.1 单测：schema 解析（省略 auth、stdio 拒绝 auth）、grant 读写、401 换发与每次 outage 至多一次 (covers: mcp-server-auth/已有条目无需迁移, mcp-server-auth/401 触发刷新且不重试风暴)
- [x] 7.2 单测：无凭据 provider 与无 webserver 的降级路径（含已存 grant 仍可解析） (covers: mcp-server-auth/无 webserver 时已授权服务器照常连接, mcp-server-auth/无 webserver 时无法发起新授权)
- [x] 7.3 REAL-composition 测试：经 Loader 与真实 cordis.yml 启动，断言 needs-auth，并断言未命名 auth 的服务器行为不变 (covers: mcp-server-auth/完成授权后自动连接)
- [x] 7.4 更新 `packages/mcp/mcp-manager/README.zh.md` 与 `packages/mcp/mcp-client/README.zh.md`，含「已知限制与延期工作」（profile 差异、不做 DCR、不做 static、mcp.json 单向） (covers: design/D4)
- [x] 7.5 新增 Agent Note 记录决策依据 (covers: design/D2, design/D3)
