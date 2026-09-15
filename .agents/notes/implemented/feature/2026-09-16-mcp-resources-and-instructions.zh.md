# Agent Note: MCP 资源访问、服务器指令与共享工具的作用域生命周期

Status: implemented

## Problem

本地 `dsh-mcp-client` 只桥接 MCP 服务器的 Tools 能力：服务器自报的工具被注册进 `ctx.tools`，除此之外服务器提供的资源（Resources）完全不可见，模型的系统提示词也不包含任何服务器指令。

MCP 服务器常用 Resources 暴露文档与结构化数据，用 `instructions` 声明使用约定。缺少这两项意味着模型既看不到服务器提供的文档，也不知道服务器的使用约束。而系统提示词组装契约当时也不支持「不参与变量插值」的段落——服务器指令是外部字面文本，其中的花括号会被插值引擎当作未知变量抛错。

## Decision

新增 `packages/mcp/mcp-resources`：`ctx.mcpResources` 用 `dsh-scope` 的 `ScopedLayers` 与 `NamedEntries` 维护每个作用域的资源提供方集合。请求时用 `exec.agent` 合并作用域链查找提供方，找不到则抛出说明该服务器在当前 agent 作用域不可用的错误——**在发起任何网络操作之前**失败。

三个工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）是**共享的**：它们不属于任何单个服务器，而是按 `server` 参数分派。因此注册时机由作用域内的提供方数量决定——首个提供方注册时经 `registerResourceTools` 注册全部三个，最后一个卸载时移除。这避免了「没有服务器时也暴露三个必然失败的工具」，也让工具 schema 只在真正有用时进入提示词。资源服务独立于首个提供方插件拥有这组共享工具 effect，因此卸载某个提供方不会移除其他服务器仍需要的工具。共享工具注册失败时整组回滚。

服务器指令归 `dsh-mcp-client` 所有：每个已连接服务器贡献一个名为 `mcp:<serverName>` 的段落，文本是初始化时返回的 instructions。段落随连接代际变化——连接成功时设置，失败、放弃重连、断开或释放时清空为空字符串。空字符串使该段落不进入最终提示词，因此服务器未提供指令时不留下空段落。

指令长度受 `maxInstructionBytes` 约束（默认 32768 字节），**超限时使该次连接失败而非截断**：截断后的指令可能语义不完整，静默截断比失败更危险。

`PromptSection` 新增可选的 `interpolate?: boolean`（缺省按 `true` 处理），同时加到 `AssembledSection`，`renderPrompt` 按 `interpolate === false` 直接取原文。`SECTION_ORDERS` 新增 `MCP_SERVERS: 3100`，落在 `TOOL_REPORT: 2900` 与 `TOOLS_SDK: 5000` 之间。

`registerServerContext` 用 `ctx.inject(['mcpResources'], …)` 与 `ctx.inject(['systemPrompt'], …)` 注册，而非静态要求这两个服务存在：只用 `dsh-mcp-client` 而不挂 `dsh-mcp-resources` 的组合仍应正常工作（只是没有资源工具），没有 system prompt 服务的极简组合也应能挂载 MCP 客户端。

`startConnection` 的既有五参数签名不变，新能力只挂在返回的 `ConnectionHandle` 上（`ConnectionHandle extends ServerContext`）。

## Alternatives considered

**把三个资源工具挂在每个服务器实例下**：不采用。工具名会按服务器前缀分裂（`mcp__github__list_resources` 之类），模型需要在每个服务器上分别发现同名能力，而且没有服务器时这些工具仍存在但必然失败。

**把服务器指令并入既有的 MCP 工具提示词段落**：不采用。指令属于服务器级元数据而非工具描述，混入工具段落会让它随工具集合变化而被重写，且无法在连接断开时独立撤回。

**截断超长指令而非失败**：不采用。截断后的指令可能丢失关键约束，模型会按不完整规则行事；失败让部署方显式调整上限或服务器配置。

**把资源内容作为结构化工具输出直接返回而不渲染**：不采用。模型需要可读文本，二进制载荷需要说明性替代。

**让 `registerServerContext` 静态注入两个服务**：不采用。那会把「是否挂载资源包」变成组合的硬性要求，破坏只桥接工具的最小组合。

**升级到 `@modelcontextprotocol/client@2.0.0`**：不采用，且与本变更无关。本地 SDK 1.29.0 的 `Client` 已提供 `listResources`、`listResourceTemplates`、`readResource` 与 `getInstructions`，够用；SDK 迁移涉及协议协商、transport 所有权与输出校验，属于单独评估的范围。

## Consequences

本批次不动本地自建能力：`mcp-manager`（含 OAuth）与 `mcp-client` 的 `allowedTools` 白名单都作用于**服务器自报工具**——白名单在 `syncTools` 阶段按原始 wire 名称剪枝，OAuth 在建立连接前解析凭据。资源工具是**客户端自注册的共享工具**，不经 `syncTools`，因此不受白名单过滤；资源读取走已建立的连接代际，因此不涉及凭据解析。

`interpolate` 是 `packages/core/system-prompt` 的公开契约变更：任何以字面文本注册段落的贡献方都可以退出插值，这也是服务器指令之外的通用能力。

指令超限使连接失败，因此一个返回超长 instructions 的服务器在部署方调整 `maxInstructionBytes` 或服务器配置之前无法使用。这是有意的取舍。

`MCP_SERVERS: 3100` 落在工具类段落之后、SDK 段落之前，与工具段落相邻且不影响既有顺序。

## Testing

`packages/core/system-prompt/tests/system-prompt.spec.ts` 覆盖 `interpolate: false` 保留花括号字面量、省略该字段的段落照常插值、`MCP_SERVERS` 可解析且落在 `TOOL_REPORT` 与 `TOOLS_SDK` 之间。

`packages/mcp/mcp-resources/tests/resources.spec.ts` 覆盖无提供方时工具不存在、首个提供方使工具出现、最后一个卸载时移除、允许重新注册、同作用域重复注册被拒、跨作用域可见性与继承回退、不可用服务器名在请求前失败且不触碰提供方、缺少 `server` 参数在派发前失败、共享工具注册失败时回滚、三个工具的参数透传（游标与 URI），以及 `renderResourceResult` 的二进制说明文字与来源标注。

`packages/mcp/mcp-client/tests/server-context.spec.ts` 覆盖字面量指令注入与随作用域释放撤回、指令变化反映到下一次组装、空指令不留下段落、作用域隔离，以及未挂载 `mcp-resources` 时只贡献段落、不注册资源工具。

`packages/mcp/mcp-client/tests/apply.spec.ts` 覆盖无指令或指令全为空白时不注入带来源标注的文本，以及按完整带来源标注 UTF-8 文本计量字节数——超限时连接失败且不注册任何工具，刚好落在上限内时连接成功且花括号保持字面量。

MCP SDK 的 mock `Client` 需要补 `getInstructions`：生产代码在连接成功后读取它，缺这个方法会让工具注册根本不发生。

## Related

- [MCP 客户端插件](2026-07-07-mcp-client-plugin.zh.md)——服务器配置、工具命名与传输。
- [MCP 客户端自动重连](2026-08-06-mcp-client-auto-reconnect.zh.md)——连接代际与重连预算。
- [MCP 客户端工具白名单](2026-09-08-mcp-client-tool-allowlist.zh.md)——白名单只作用于服务器自报工具。
- [稀疏第一方提示词顺序](../architecture/2026-08-25-sparse-first-party-prompt-section-orders.zh.md)——具名段落位置的分配方式。
