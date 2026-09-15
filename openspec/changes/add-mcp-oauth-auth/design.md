# 技术决策

设计草案见 [docs/design/mcp-oauth.zh.md](../../../docs/design/mcp-oauth.zh.md)。本文件记录决策编号，供 tasks.md 锚定。

### D1 auth 判别联合只加在 HTTP 条目上

stdio 服务器没有 HTTP 端点，不存在 OAuth 授权码流程，因此 `auth` 只进入 `HttpServerSchema`，`StdioServerSchema` 不变。联合为 `none` | `oauth`，缺省按 `none` 处理，已有条目零迁移。

### D2 令牌存 GrantRecord，不存 settings 文档

每个 OAuth 服务器一条 `GrantRecord`，key 由 `credentialKey('mcp-oauth', serverName)` 派生。payload 承载 access token、refresh token、过期时间与 scope。

三条理由：`modifyRecord()` 提供跨进程排他的读-改-写，是 refresh_token 轮换的安全写入路径；`resolve()` 的"每次操作重新解析"语义让刷新后的令牌无需重启即生效；令牌不进 settings 文档，因此不参与 `mcp.json` 同步，也不受脱敏字段被 wire 整体编辑丢弃的影响。

`GrantRecord` 目前全仓零消费者，是凭据 seam 为授权许可预留的空位，本次是其首个使用者。

### D3 needs-auth 是与 failed 并列的独立状态

现有状态机中，未授权的服务器报 `failed`，语义错误——用户尚未做授权动作，不是故障。新增 `needs-auth` kind，判别点是"用户动作能否修复"而非"连接是否成功"：凭据缺失或失效且用户可修复 → `needs-auth`；服务器不可达、schema 冲突、重连预算耗尽 → `failed`。

### D4 无 webserver 时惰性降级

`webServer` 是可选服务，headless / tui profile 下不存在。降级行为：`ctx.get('webServer')` 惰性探测，缺失则不注册回调路由；已有有效 grant 照常使用，OAuth 服务器在 headless 下仍可连接，只是无法发起新授权；需要授权而无 webserver 时报 `needs-auth` 并在诊断文本说明原因。

沿用 `mcpJsonPath` 在没有文件型 settings provider 时返回 `undefined` 的同一形状。profile 间行为差异需在包 README 的"已知限制与延期工作"记录。

### D5 浏览器半身不实现 OAuth、不持令牌

流程为：用户点"去认证" → Host Remote 方法返回授权 URL → 浏览器 `window.open` → 服务端重定向到 DSH webserver 回调路由 → Host 用 code 换 token、写 GrantRecord、触发重连 → `mcp/status` 推送 → 设置页自动刷新。

浏览器侧只新增一个按钮与一个徽章文案，不新增 store，也不接触任何令牌。既有 `McpStatusStore` 通过 `mcp/status` 事件自动重拉。这符合 `packages/client/AGENTS.md` 的 "web 层是纯呈现" 与 "组件永不接触 ctx" 约束。

### D6 mcp.json 对 OAuth 只读不写

读方向从 `mcp.json` 识别 OAuth 服务器并转换为 `auth: { kind: 'oauth' }`；写方向 `settingsToMcpJson` 不渲染 OAuth 细节，避免与其他平台的字段语义分歧。后果是手编 `mcp.json` 无法配置 client_id，只能在设置页配置。

## 被拒绝的方案

**自建令牌文件**（外部插件的做法）：令牌写进 `~/.dsh/mcp-manager.json` 明文文件。被拒因是绕开已有凭据 seam 且明文落盘。

**在浏览器半身实现 OAuth**：违反 web 层纯呈现约束，且令牌会进入浏览器。

**on-demand 工具 broker**：不在本次范围。它按 `startsWith('mcp__')` 全局过滤提示词中的工具，并用"凭 token 临时授信"绕过 guard，而 `packages/core/tools/src/index.ts` 的 guard 契约是单调否决、不可撤销。在内置实现中开这个洞是破坏自家安全模型。
