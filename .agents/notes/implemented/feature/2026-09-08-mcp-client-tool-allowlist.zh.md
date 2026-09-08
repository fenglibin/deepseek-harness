# Agent Note: MCP client raw-tool allowlist

Status: implemented

## Problem

[MCP 客户端](2026-07-07-mcp-client-plugin.zh.md)桥接一台服务器时注册它列出的每一个工具，而每个工具的名称、描述与输入 schema 都会进入每一次模型请求。暴露 11 个工具的 codegraph 服务器在只需要其中 2 个的部署里，仍然付出 11 份工具定义的 token，并把 9 个用不到的能力放进模型的行动面。此前的唯一收窄手段是 `tools.restrict()`：它要求 agent 作用域（全局调用会被拒绝）、作用于已注册工具的可见性而非注册本身，并且拒绝任何当时未知的全局工具名——而 MCP 工具是在连接建立之后才异步注册的，调用方没有一个能安全枚举它们的时刻。部署方因此无法用配置表达「只桥接这几个工具」。

## Decision

两种传输的 `Config` 都接受 `allowedTools?: string[]`，其条目是 MCP 服务器 `tools/list` 里的**原始**工具名，不是 `mcp__<serverName>__` 公开名——公开名是原始名的规范化派生值，带 hash 后缀时不可逆，而原始名才是 `tools/call` 上发送的那个协议名。

**过滤点在 fetch 阶段。** `syncTools` 排空分页 `tools/list` 时跳过不在掩码内的原始名，被跳过的工具从不进入 `definitions`，因此既不注册、不进 prompt，也不可被模型或程序化调用方执行。这保留了既有的「要么完整世代，要么没有」语义：一次同步仍然原子地交换整个世代，掩码只是决定这一代包含什么。

**加载期解析。** `resolveAllowedTools()` 是显式解析步骤，与 `resolveReconnectPolicy()` 同构：程序化构造可以绕过 Schemastery，因此非空、无空串、无重复的约束在这里重新判定，违规在 `apply` 注册任何 effect 之前令该实例失败。Schemastery 的 `z.array()` 默认物化成 `[]`，会抹掉「未配置」与「显式空列表」的区别，所以 schema 用 `.default(undefined as unknown as string[])` 保留省略——这正是 `tool-subagent` 的 `toolFilter` 用同一手法防住的问题。

**空列表是错误，不是「零工具」。** 想要没有工具就别挂载这台服务器；把空列表当配置错误拒绝，与 `tool-subagent` 拒绝既不填 `allow` 也不填 `deny` 的过滤器一致。

**未命中的名字只告警。** 每次同步后，掩码中服务器未列出的名字以 warn 记录一次（按页累积后判定，不是每页一次），已列出的工具照常注册。服务器升级会重命名工具，一个 stale 名字不应让整台服务器的所有工具消失。

**用户管理的服务器走同一字段。** `dsh-mcp-manager` 的 `McpServerEntry` 与 `mcp.json` 条目都接受同名的 `allowedTools`，manager 在 `toMcpClientConfig` 里把它传给桥接，因此 `cordis.yml` 直配与配置界面/`mcp.json` 两条路径的语义完全一致。settings schema 与 mcp-client 的 schema 用同一个 `.default(undefined)` 手法保留省略——manager 侧若物化成 `[]`，每个未配置掩码的条目都会在挂载时被拒绝。`mcp.json` 是跨厂商格式，`allowedTools` 是 dsh 扩展字段：`mcpJsonToSettings` 读入、`settingsToMcpJson` 写回，其他平台按未知字段忽略。掩码变化会改变条目值，`reconcile` 的 `serversEqual` 因此判定为变化并重新挂载该服务器。

**配置界面还有一份客户端镜像。** `dsh-client-ui-settings-mcp` 因 bundle 纯度门禁不能引用 Host 符号，因此自带 `McpServerEntry`/`McpJsonServer` 的类型镜像，以及 `entryToServerJson`/`serverJsonToEntry` 这对与 Host `settingsToMcpJson`/`mcpJsonToSettings` 对称的转换镜像。掩码在四处同时落地——mcp-client 的插件 schema、manager 的 settings schema、`mcp.json` 文档模型、客户端镜像——漏掉客户端镜像的表现不是报错，而是界面保存时把掩码静默丢掉。

## Alternatives considered

**用既有的 `tools.restrict({ allow })`。** 否决：它要求 scoped context，mcp-client 挂在全局；它过滤可见性而工具仍被注册；它拒绝未知工具名，而 MCP 工具在连接后才出现，没有合法的调用时机。它解决的是子 agent 的能力收窄，不是桥接源头的选择。

**按公开名 `mcp__<serverName>__<raw>` 过滤。** 否决：公开名是派生值，`admin.reset` 这类名字经规范化加 12 位 hash 后无法从公开名反推原始名，掩码会成为第二个需要维护的命名层。

**把空列表解释为「不注册任何工具」。** 否决：物化空配置（YAML 里写了 `allowedTools:` 却没有条目）是最常见的形态，把它当有效配置会让部署方得到一台静默无用的服务器而非一条报错。

**未命中的名字直接令同步失败。** 否决：失败会回滚整个世代，于是一次拼写错误或一个已下线的工具会让其余工具一起消失；这与「获取阶段失败保留上一世代」的既定语义相冲突。warn 保留了可观测性，代价是拼写错误不会在启动时被拒绝。

**在 execute 层拦截被过滤的工具。** 否决：那仍需注册它们，工具定义照样进入每次请求——而削减这部分 token 正是本变更的目的。

**同时提供 `deny` 黑名单。** 推迟：白名单表达的是最小暴露，服务器新增工具时默认不暴露；黑名单在服务器新增工具时默认暴露，与本变更的意图相反。需要时按同样的解析与告警语义再加。

**只加到 `cordis.yml` 直配路径，让 manager 沿用「桥接全部工具」。** 否决：两条路径配置的是同一种服务器，语义分叉会让「在界面里改一下就丢了掩码」成为真实故障；用户管理路径反而更需要掩码，因为那里的服务器由用户自行添加、无人评审。

## Testing

单元测试（`tests/mcp-client.spec.ts`）：`resolveAllowedTools` 拒绝空列表、空串、重复项与非数组值，省略时返回 `undefined`；`syncTools` 只注册掩码内的工具、掩码跨分页生效、全部未命中时注册零个工具、再同步时注销被掩码剔除的上一代工具、被掩码剔除的工具调用时返回 `UNKNOWN_TOOL` 而不只是从可见列表里消失、未命中名字恰好告警一次且分页不重复告警、省略掩码时不告警。插件层（`tests/apply.spec.ts`）：schema 在省略时保持 `allowedTools` 缺失，配置后原样透传；`apply` 只注册名单内工具；`list_changed` 触发的再同步继续应用掩码，因此服务器后来新增的工具不会绕过它；空列表与重复项在建立连接之前就令加载失败。manager 层（`tests/mcp-json.spec.ts`、`tests/manager.spec.ts`）：`mcp.json` 的掩码双向转换并在省略时保持字段缺失、非字符串数组被拒绝、完整文档往返保留掩码；挂载一个带掩码的条目只注册名单内工具，无掩码条目注册全部工具，掩码变化触发重新挂载，空掩码的挂载失败被收容为带诊断文本的 `failed` 且不产生任何 MCP client；stdio 与 Streamable HTTP 两条挂载路径各有一条用例。文档层（`tests/mcp-document.spec.ts`）：走 `updateMcpServer` 这条界面保存路径写入掩码，挂载后只注册名单内工具，且掩码出现在持久化后的 `mcp.json` 里，因此重新读取文档会重挂出同样的受限集合。客户端镜像（`tests/mcp-server-json.client.spec.ts`）：编辑器的渲染与回读对两种传输都带上掩码、省略时字段缺失、编辑器形状往返保留掩码。E2E（`tests/mcp-client.e2e.ts`，无需密钥）：真实 stdio fixture 服务器下，掩码内的 `add` 可调用并返回 `"5"`，掩码外的 `fail` 既不出现在 `ctx.tools.schemas()` 中也不存在于注册表。快照：刻意不做——掩码不改变任何展示形态，只改变哪些工具被注册。

## Consequences

- 部署方可以逐服务器削减 prompt token 与模型的行动面；被过滤的工具对模型与程序化调用方都不可见，因此这也是一处权限面收敛。
- 过滤发生在注册源头而非可见性层，因此不引入「已注册但不可调用」这一新状态，也不与 `tools.restrict()` 的语义重叠。
- 白名单是部署期静态配置：服务器新增工具不会自动出现，需要更新配置才能桥接。这是有意的默认不暴露，代价是升级服务器后需要一次配置变更。
- 名字拼错只能靠日志发现，不会让服务器启动失败。以 warn 而非 error 换取「一次 stale 名字不至于让整台服务器的工具消失」。
