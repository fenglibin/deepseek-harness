# Agent Note: MCP OAuth grants live in the credentials seam

Status: implemented

## 问题

内置 [MCP 客户端](2026-07-07-mcp-client-plugin.zh.md) 只支持以静态 `headers` 承载凭据，HTTP 传输原样透传配置中的请求头。需要浏览器登录的 MCP 服务器因此无法在内置设置页完成授权。

替代路径是引入第三方插件 `dsh-mcp-manager`（hyqhyq3）。该插件与内置实现并存而非替换：两者的 `cordis.patch.yml` 行 id 同为 `mcp-manager`，且 patch 的 `insert` 语义是追加，因此会同时加载。后果是设置页出现两个入口（slot id 分别为 `mcp` 与 `mcp-manager`，不冲突因而两行都进 ledger）、两份互不相通的服务器列表（内置存 settings 文档，外部存 `~/.dsh/mcp-manager.json`），以及共用的 `mcp__<name>__` 工具前缀在同名服务器上碰撞。

## 决策

把 OAuth（授权码 + PKCE）内置，并让令牌归属于已有的凭据 seam，而非新造存储。

**令牌存 `GrantRecord`，不存 settings 文档。** 每个 OAuth 服务器一条记录，key 由 `credentialKey('mcp-oauth', serverName)` 派生。三条理由：`modifyRecord()` 提供跨进程排他的读-改-写，两个 Host 同时轮换一个 refresh token 不会丢失写入；`resolve()` 的"每次操作重新解析"语义让刷新后的令牌无需重启即生效；令牌不进 settings 文档，因此也不参与 `mcp.json` 同步。`GrantRecord` 在本次之前全仓零消费者，是凭据 seam 为授权许可预留的空位。

**授权对话交给 `dsh-authorization`，本包只实现 OAuth 协议。** 仓库已有该 seam，专门承载「必须由人交出来」的凭据：它拥有 attempt 生命周期（每凭据同时一次）、把 notice 与 prompt 路由到发起方、并核实 flow 真的提交了记录。MCP 因此注册一个 flow，而不是另起一套 attempt 机制。两个后果直接来自这个拆分：headless 组合没有回调路由，但 seam 的 prompt 通道让用户粘贴重定向 URL 即可完成授权；`authorization` 是可选服务，缺失时服务器照常挂载、已存令牌照常使用，只是无法发起新授权。回调 origin 由设置页报告（只有浏览器知道自己用哪个地址访问了这个部署），Host 校验其端口与本部署一致后拒绝指向别处的重定向，而 PKCE 仍是安全边界。

**凭据经一个新的能力接缝进入 mcp-client。** manager 通过 `ctx.provide('mcpAuthSink', …)` 提供解析器；mcp-client 在**构造 transport 与 Client 之前**解析一次，因此刷新后的令牌对下一代立即生效，且 config 中不含任何密钥。解析器抛错被收容为"不可用"，使另一个插件的凭据逻辑无法破坏它只作为旁观者的连接循环。

**`needs-auth` 是与 `failed` 并列的状态，不是它的同义词。** 判别点是"用户动作能否修复"：凭据缺失或失效且用户可授权 → `needs-auth`；服务器不可达、schema 冲突、重连预算耗尽 → `failed`。一台等待授权的服务器**不进入重连退避**——服务器是可达的，退避只会重复一次本来就正确的请求，并把用户唯一需要知道的事实埋在反复的告警之下。

**无 webserver 时惰性降级。** `webServer` 是可选服务。headless / tui profile 下不注册回调路由，但已存储的有效 grant 照常使用——可以连接，只是无法开始新的授权。这与 `mcpJsonPath` 在没有文件型 settings provider 时返回 `undefined` 的形状一致。

**`mcp.json` 对 OAuth 读写对称。** 读方向识别 `authMode: "oauth"` 及 dsh 的端点字段，写方向同样渲染它们，`none` 条目则一个字都不多写。对称是必需的而非风格取舍：设置页的编辑功能建立在 `mcp.json` 往返之上，单向省略会让编辑器看不到字段、保存时把它写回 `none`——编辑一个 OAuth 服务器即静默清除其配置。`allowedTools` 早已确立扩展字段读写对称的先例。命名 OAuth 却缺少必填字段的条目**报错**而非静默降级为 `none`，使半配置的服务器不会看起来像一个可用的 OAuth 服务器。

## Alternatives considered

**自建令牌文件**（外部插件的做法）：把令牌写进 `~/.dsh/mcp-manager.json`。被拒因是绕开已有凭据 seam，且明文落盘；该插件自己在 Limitations 中要求把该文件当作密钥处理。

**在浏览器半身实现 OAuth**：违反 `packages/client/AGENTS.md` 的"web 层是纯呈现"与"组件永不接触 ctx"约束，且令牌会进入浏览器。实际做法是浏览器只拿到一个授权 URL 并 `window.open` 它，Host 完成交换。

**自建授权 attempt 生命周期**（初版实现）：在 `oauth-flow.ts` 里自己维护 pending state、TTL 与回调路由。被拒因是 `dsh-authorization` 已经拥有这些语义，而自建版本同时丢掉了它的两样能力——提交确认（`authorized` 只在该 seam 观察到记录写入时才成立）与 headless 下的 prompt 通道。自建版本还按 `start()` 的调用记录回调 origin，导致不经 `start()` 发起的 attempt（headless 直接经 seam 发起）无处取 origin 而失败。

**on-demand 工具 broker**（同一外部插件的另一能力）：不在本次范围。它按 `startsWith('mcp__')` 全局过滤提示词中的工具，并用"凭 token 临时授信"放行嵌套调用，而 `packages/core/tools/src/index.ts` 的 guard 契约是单调否决、不可撤销；在内置实现中开这个洞是破坏自家安全模型。省提示词 token 的替代方案是既有的 `allowedTools` 白名单。

**动态客户端注册（RFC 7591）与服务端发现**：本期不做。条目须显式给出 `authorizationUrl`、`tokenUrl` 与预注册的 `clientId`。

## Consequences

内置设置页成为 MCP 服务器唯一的授权入口，无需引入会并存出第二个设置页的第三方插件。一台等待授权的服务器占用 `needs-auth` 并停止重连，因此界面上的「需要授权」与「连接失败」是两种可区分的用户动作指引，而不是同一个红色错误。

代价是 OAuth 配置必须显式：条目要给出端点与预注册 `clientId`，首次授权需要一次浏览器往返，且没有 webserver 的 profile 无法开始新授权。

## 验证

- `packages/mcp/mcp-manager/tests/oauth.spec.ts`：schema 解析（省略 auth 为 `none`、stdio 拒绝 auth）、grant 经真实 `CredentialProvider` 的往返、auth sink 的五条解析路径。
- `packages/mcp/mcp-client/tests/status-sink.spec.ts`：`needs-auth` 上报且不建 transport、无重连、resolver 抛错收敛为 `failed`、stdio 不咨询 resolver。
- `packages/mcp/mcp-manager/tests/oauth-composition.spec.ts`：REAL-composition——`cordis.yml` 经 Loader 与 app/process 启动，断言 OAuth 服务器报 `needs-auth`，以及未命名 `auth` 的服务器行为不变（防止新字段改变既有条目）。
- `packages/mcp/mcp-manager/tests/mcp-json.spec.ts`：`mcp.json` 读方向识别 OAuth、缺少端点时报错、写方向不渲染 OAuth 字段。
