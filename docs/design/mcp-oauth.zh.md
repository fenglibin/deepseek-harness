---
description: "内置 MCP 管理接入 OAuth（授权码 + PKCE）的设计草案：复用 dsh-credentials 的 GrantRecord 承载令牌，用 webserver 路由承接回调，并把 needs-auth 状态接入设置页。"
kind: "design-draft"
---

# 内置 MCP 管理的 OAuth 认证设计

## 目标与范围

给内置 `dsh-mcp-manager` 的 HTTP 服务器条目增加 OAuth（授权码 + PKCE）认证，使需要浏览器登录的 MCP 服务器可以在内置设置页中完成授权，而无需引入外部插件。

**在范围内：**

- `mcp` settings 命名空间中 HTTP 条目的 `auth` 判别联合（`none` / `static` / `oauth`）
- 令牌与刷新令牌的持久化与轮转
- 授权码回调路由
- `needs-auth` 状态在设置页的呈现与"去认证"入口

**不在范围内：**

- stdio 服务器的认证（stdio 无 HTTP 端点，凭据走既有 `env`）
- 工作区级 MCP 配置（需改 `AgentSetup` 契约，另行设计）
- on-demand 工具 broker（与安全不变量冲突，见文末"被拒绝的方案"）

## 现状：可用的接缝

本次设计不新增基础设施，而是接上仓库中已存在但尚未被填充的四个接缝。

### 1. `GrantRecord` —— 令牌的归属位置

`packages/credentials/credentials/src/types.ts:52` 定义了：

```ts
export interface GrantRecord {
  readonly kind: 'grant'
  /** Owner-defined JSON value; opaque to the seam and to every other plugin. */
  readonly payload: unknown
}
```

全仓搜索确认：**`GrantRecord` 目前没有任何消费者**，仅在 `CredentialRecord` 联合与 cordis API 目录的投影中出现。它是为"授权许可"预留的空位，本次正是它的首个使用者。

`CredentialProvider.modifyRecord()` 的文档（`packages/credentials/credentials/src/index.ts:237`）已经写明它为何适合承载 OAuth 令牌轮转：

> Serialized read-modify-write over one record — the only write path. Exclusion holds across processes where the backing store supports it, which is what makes a token refresh safe: two processes rotating one refresh token concurrently would otherwise lose whichever wrote first.

这句话直接对应 refresh_token 轮换的并发正确性要求。同时 `resolve()` 要求"consumers re-resolve at each operation and must not cache across operations"，这正是 401 → 刷新 → 下次调用自动读到新值所需要的语义。

**结论：不自建令牌文件。** 外部插件把令牌写进 `~/.dsh/mcp-manager.json` 明文文件并自认"treat the file as a secret"；内置方案把 grant 交给凭据 seam，令牌不落 settings 文档。

### 2. `dsh-authorization` —— 授权对话的归属处

`packages/credentials/authorization` 是仓库既有的 seam，专门承载「必须由人交出来」的凭据：flow 注册表、每凭据一次 attempt、notice/prompt 路由到发起方、以及提交确认（`authorized` 只在该 seam 观察到 `credentials/record-updated` 时才成立）。

它同时解决了两个否则要自建的问题：headless 组合没有回调路由，但 prompt 通道让用户粘贴重定向 URL 即可完成授权；attempt 生命周期与取消语义由 seam 统一，而不是每个协议各写一套。

`authorization` 与 `webServer` 一样是可选服务，经 `ctx.inject` 接入：缺失时服务器照常挂载、已存令牌照常使用，只是无法发起新授权。

### 3. `WebRoute` —— 回调路由的挂载点

`packages/host/webserver/src/index.ts:165` 提供 `register(route: WebRoute)`，回调可挂在 `/mcp/oauth/callback/<serverName>` 之类的 prefix 路由上。

`webServer` 是可选服务：headless / tui profile 下不存在。这带来本设计的核心约束（见下节）。

### 4. `McpStatusSink` —— 状态的既有通道

`packages/mcp/mcp-client/src/connection.ts:79` 定义了 sink 契约，`McpManager` 已实现并在每次状态迁移时 `emit('mcp/status')`。状态 kind 当前为：

```ts
type McpServerStatusKind = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'unknown'
```

### 5. `McpJson` 跨厂商格式

`mcp.json` 的读写转换集中在 `packages/mcp/mcp-manager/src/mcp-json.ts`，`settingsToMcpJson` / `mcpJsonToSettings` 是纯函数。OAuth 字段必须通过这对函数往返，且要维持"其他平台读它时按未知字段忽略"的既有约定。

## 核心设计决策

### D1：auth 判别联合只加在 HTTP 条目上

stdio 服务器没有 HTTP 端点，不存在 OAuth 流程。因此 `auth` 只进入 `HttpServerSchema`，`StdioServerSchema` 不变。

```ts
export type McpHttpAuth =
  | { readonly kind: 'none' }
  | { readonly kind: 'oauth'; readonly clientId: string; readonly scopes?: readonly string[] }
```

**范围已定（与用户确认）：**

- **本期不做 `static` 模式。** 静态 Bearer 令牌继续使用现有 `headers` 字段（`Authorization: Bearer <token>`）。代价是静态令牌以明文进 settings 文档，但避免了新增 `tokenRef` 解析路径。后续若需要，可独立补 `static` 分支。
- **本期不做 RFC 7591 动态客户端注册。** 只支持预配置 `clientId` 的授权码 + PKCE 流程。要求动态注册的服务器本期不可用。
- **只支持授权码 + PKCE，配合预配置的 client_id。**

现有 `headers` 字段保留，作为附加请求头的通道，与 `auth` 并存而非互斥。

**兼容性与默认值**：`auth` 缺省时按 `none` 处理，已有条目无需迁移。`auth` 是新增可选字段，`mcp.json` 往返时其他平台仍会忽略它。

### D2：令牌存 GrantRecord，不存 settings 文档

每个 OAuth 服务器对应一条 `GrantRecord`，key 由 `credentialKey('mcp-oauth', serverName)` 派生产生。payload 承载 access token、refresh token、过期时间与 scope。

**理由：**

1. `modifyRecord()` 提供跨进程排他的读-改-写，是 refresh_token 轮换的安全写入路径
2. `resolve()` 的"每次操作重新解析"语义让刷新后的令牌自动生效，无需重启
3. 令牌不进入 settings 文档，因此不参与 `mcp.json` 同步，也不会被脱敏字段规则丢弃

注意 `McpManager` 的 schema 注释已说明 `env` / `headers` 为何不能用 `role('secret')`：列表是从 wire 视图整体编辑的，脱敏字段会在每次写入时被静默丢弃。OAuth 令牌走 GrantRecord 恰好绕开了这个陷阱。

### D3：未授权不是失败，是一种独立状态

这是本设计对既有状态机最重要的扩展。

现状里，一个需要授权但尚未授权的服务器会走 `failed`，设置页显示错误文本。这在语义上是错的：用户还没做授权动作，不是"失败了"。

新增状态 kind：

```ts
type McpServerStatusKind = ... | 'needs-auth'
```

语义边界：

- `needs-auth` —— 服务器可达，但凭据缺失或已失效，且**用户动作可以修复**（点击认证）
- `failed` —— 用户动作无法直接修复的故障（服务器不可达、schema 冲突、重连预算耗尽）

判别点在于"是否可通过用户授权修复"，而非"连接是否成功"。

### D4：无 webserver 时优雅降级，不报错

`webServer` 是可选服务。headless / tui profile 下 OAuth 无法完成浏览器跳转，但**不能让整个 MCP 管理挂掉**。

降级行为：

1. `mcp-client` 以 `ctx.get('webServer')` 惰性探测；不存在则不注册回调路由
2. 已有的有效 grant 照常使用——OAuth 服务器在 headless 下仍可连接，只是无法发起**新的**授权
3. 需要授权而无 webserver 时，报 `needs-auth` 并在诊断文本中说明原因

`packages/mcp/mcp-manager/src/manager.ts:133` 已有同类先例：`mcpJsonPath` 在没有文件型 settings provider 时返回 `undefined`，整条同步路径安静地不启用。本设计沿用同一形状。

**注意**：这引入了 profile 间行为差异，属于产品可见行为，需在 README 的"已知限制与延期工作"中记录。

### D5：认证动作由 Host 暴露 Remote 方法，浏览器只发起

浏览器半身不实现 OAuth 逻辑，也不持有任何令牌。流程：

1. 用户点"去认证" → `ctx.remote.mcp.startAuth(serverName)` → Host 返回授权 URL
2. 浏览器 `window.open(url)` 打开服务端登录页
3. 用户同意 → 服务端重定向到 DSH webserver 的回调路由
4. Host 用 code 换 token，写入 GrantRecord，触发重连
5. 状态变为 `connected`，`mcp/status` 推送，设置页自动刷新（既有机制）

浏览器侧只新增一个按钮和一个状态徽章文案，不新增 store。既有 `McpStatusStore` 通过 `mcp/status` 事件自动重拉，无需改动。

### D6（已被 D7 取代）：`mcp.json` 对 OAuth 只读不写

初版让 `settingsToMcpJson` 不渲染 OAuth 细节，理由是避免与其他平台的字段语义分歧。

**该决策已被 D7 取代。** 它漏掉了一个关键事实：设置页的编辑功能建立在 `mcp.json` 往返之上。写入方向省略字段，编辑器就看不到它们，保存时便把 `auth` 写回 `none`——**编辑一个 OAuth 服务器会静默清除其配置**。这是用户可感知的数据丢失，而非风格取舍。

### D7：OAuth 字段读写对称

`settingsToMcpJson` 与客户端的 `entryToServerJson` 在条目为 OAuth 时写出 `authMode` / `clientId` / `authorizationUrl` / `tokenUrl`，以及仅在携带时的 `scopes`。

三条规则：仅当 `auth.kind === 'oauth'` 时写出，因此 `none` 条目输出逐字不变；`scopes` 与 `allowedTools` 同规则，省略则保持省略；其他平台读到按未知字段忽略。

`allowedTools` 已经证明扩展字段读写对称可行且被接受，本决策沿用该先例。读方向的「沉默继承」保留，但角色从「缓解丢配置」变为「升级与手编兼容」——旧版本写下的 `mcp.json` 没有这些字段，而 settings 已有 OAuth 条目，此时把沉默读作 `none` 会让第一次手编丢配置。

## 已确认的范围边界

| 问题 | 决策 | 后果 |
|---|---|---|
| `static` 模式 | 本期不做 | 静态令牌继续用 `headers`，明文进 settings 文档 |
| RFC 7591 动态注册 | 本期不做 | 要求动态注册的服务器不可用 |
| `mcp.json` OAuth 字段 | 只读不写 | 手编 `mcp.json` 无法配置 OAuth |

## 被拒绝的方案

**自建令牌文件**（外部插件的做法）：把令牌写进 `~/.dsh/mcp-manager.json`。被拒因是绕开了仓库已有的凭据 seam，且明文落盘。`GrantRecord` 是为此设计的现成归属位置。

**在浏览器半身实现 OAuth**：违反 `packages/client/AGENTS.md` 的"web 层是纯呈现"与"组件永不接触 ctx"约束，且令牌会进入浏览器。

## 影响面

| 包 | 改动 |
|---|---|
| `packages/mcp/mcp-manager` | `auth` schema、GrantRecord 读写、OAuth 流程、Remote 方法、状态机扩展 |
| `packages/mcp/mcp-client` | HTTP transport 前解析凭据、401 触发刷新、`needs-auth` 上报 |
| `packages/client/ui-settings-mcp` | `needs-auth` 徽章、"去认证"按钮、locale 文案 |
| `packages/credentials/credentials` | 无改动（复用现有 `GrantRecord`） |

涉及 Host 与 Client 两侧，且改动 settings 持久化 schema —— l2，需要 OpenSpec。
