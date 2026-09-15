# 技术决策

设计草案见 [docs/design/upstream-diff-analysis.zh.md](../../../docs/design/upstream-diff-analysis.zh.md) 第 3.1 节。本文件记录决策编号，供 tasks.md 锚定。

### D1 先补齐 system prompt 的两项前置

`packages/core/system-prompt` 需要两个改动，两者都是本变更的硬前置。

**`PromptSection.interpolate?: boolean`**：段落默认参与 `{{variable}}` 插值。MCP 服务器指令是**外部字面文本**，其中可能包含花括号；若不关闭插值，插值引擎会把它们当作未知变量抛错。字段缺省为 `true` 以保持既有段落行为。该字段需同时加到 `PromptSection`（注册输入）与 `AssembledSection`（组装结果），并在 `renderPrompt` 中按 `interpolate === false` 分支直接取原文。

**`SECTION_ORDERS.MCP_SERVERS: 3100`**：段落位置常量。本地现有取值在 `TOOL_REPORT: 2900` 之后直接跳到 `TOOLS_SDK: 5000`，3100 落在两者之间，与工具段落相邻且不影响既有顺序。

### D2 资源访问是作用域化的服务

`ctx.mcpResources` 用 `dsh-scope` 的 `ScopedLayers` 维护每个作用域的资源提供方集合。本地 `packages/core/scope` 已导出所需全部原语（`NamedEntries`、`ScopedLayers`、`createScope`、`scopeOf`、`ScopeKey`、`ScopeLayer`），无需新增依赖。

按作用域而非全局的理由：MCP 服务器按 profile 与 agent 作用域挂载，资源可见性必须与工具可见性一致。请求时用 `exec.agent` 合并作用域链查找提供方，找不到则抛出说明该服务器在当前 agent 作用域不可用。

### D3 三个工具随首个提供方注册、随最后一个卸载

三个工具是**共享的**：它们不属于任何单个服务器，而是按服务器名参数分派。因此注册时机由作用域内的提供方数量决定——第一个提供方注册时注册全部三个工具，最后一个提供方卸载时移除它们。

这避免了"没有服务器时也暴露三个必然失败的工具"，也让工具 schema 只在真正有用时进入提示词。

### D4 二进制载荷不进模型上下文

`read_mcp_resource` 的结果可能是二进制（MCP 协议用 base64 的 `blob` 字段承载）。渲染时把 `blob` 键的字符串值替换为说明文字（含 base64 长度），原始数据仍保留在工具结果 JSON 中供程序化调用方使用。

理由与官方一致：把 base64 载荷灌进模型上下文既浪费 token 又无助于模型理解。渲染结果前缀 `MCP server: <name>` 以标明来源。

### D5 服务器指令作为独立段落注入，且不插值

每个已连接服务器贡献一个名为 `mcp:<serverName>` 的段落，文本是服务器在初始化时返回的 instructions。段落内容随连接代际变化——连接成功时设置，失败、放弃、断开或释放时清空为空字符串。

空字符串使该段落不进入最终提示词（`renderPrompt` 过滤空文本），因此服务器未提供指令时不留下空段落。

指令长度受 `maxInstructionBytes` 约束（默认 32768 字节），超限时**使该次连接失败**而非截断：截断后的指令可能语义不完整，静默截断比失败更危险。

`interpolate: false` 是必需的：指令是外部文本，其中的花括号必须保持字面量。

### D6 资源提供方经可选服务注入，避免硬依赖

`registerServerContext` 用 `ctx.inject(['mcpResources'], …)` 与 `ctx.inject(['systemPrompt'], …)` 注册，而非在 `dsh-mcp-client` 中静态要求这两个服务。

理由是组合自由度：只用 `dsh-mcp-client` 而不挂 `dsh-mcp-resources` 的组合仍应正常工作（只是没有资源工具），而没有 system prompt 服务的极简组合也应能挂载 MCP 客户端。

### D7 本地 OAuth 与白名单不受影响

本地的 `McpAuthSink` 与 `allowedTools` 都作用于**服务器自报工具**：白名单在 `syncTools` 阶段按原始 wire 工具名剪枝，OAuth 在建立连接前解析凭据。

资源工具是**客户端自注册的共享工具**，不经 `syncTools`，因此不被白名单过滤；资源读取走已建立的连接代际，因此不涉及凭据解析。

`ConnectionHandle` 需要扩展为携带 `resources` 与 `instructions()`，但 `startConnection` 的既有五参数签名不变。

### D8 本地 SDK 版本的资源 API 可用

本地 MCP SDK 为 `@modelcontextprotocol/sdk` 1.29.0，其 `Client` 已提供 `listResources`、`listResourceTemplates`、`readResource` 与 `getInstructions`，因此本变更不需要升级 SDK。

这与官方的 `@modelcontextprotocol/client@2.0.0` 迁移是两件独立的事：SDK 迁移涉及协议协商、transport 所有权与输出校验，属于单独评估的范围。

## 被拒绝的方案

**把三个资源工具挂在每个服务器实例下**：不采用。工具名会按服务器前缀分裂（`mcp__github__list_resources` 之类），模型需要在每个服务器上分别发现同名能力，且没有服务器时这些工具仍存在但必然失败。

**把服务器指令并入既有的 MCP 工具提示词段落**：不采用。指令属于服务器级元数据而非工具描述，混入工具段落会让它随工具集合变化而被重写，且无法在连接断开时独立撤回。

**截断超长指令而非失败**：不采用。截断后的指令可能丢失关键约束，模型会按不完整规则行事；失败让部署方显式调整上限或服务器配置。

**把资源内容作为结构化工具输出直接返回而不渲染**：不采用。模型需要可读文本，二进制载荷需要说明性替代。
