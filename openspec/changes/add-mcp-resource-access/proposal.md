# 增加 MCP 资源访问与服务器指令注入

## 为什么

本地 `dsh-mcp-client` 只桥接 MCP 服务器的 Tools 能力：`packages/mcp/mcp-client/src/tools.ts` 把服务器自报的工具注册进 `ctx.tools`，除此之外服务器提供的资源（Resources）完全不可见，模型的系统提示词也不包含任何服务器指令。

MCP 服务器常用 Resources 暴露文档与结构化数据，用 instructions 声明使用约定。缺少这两项意味着模型既看不到服务器提供的文档，也不知道服务器的使用约束。

官方新增 `packages/mcp/mcp-resources`（三个共享工具）并在 `dsh-mcp-client` 中新增 `registerServerContext`（把服务器指令作为 system prompt 段落注入）。

## 做什么

- 新增 `packages/mcp/mcp-resources` 包，提供 `ctx.mcpResources` 与三个模型工具：`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`
- 在 `dsh-mcp-client` 新增 `src/server-context.ts`，把连接持有的资源访问注册进 `ctx.mcpResources`、把服务器指令注册为 system prompt 段落
- 为 `packages/core/system-prompt` 补齐两个前置能力：`PromptSection.interpolate` 字段与 `MCP_SERVERS` 段落位置常量
- 把新包挂载进 base 与 sdk-minimal 组合

## 不做什么

- 不做 MCP 提示词模板（Prompts）：官方同样不支持
- 不改本地自建的 MCP OAuth 与工具白名单：白名单作用于服务器自报工具（经 `syncTools` 剪枝），资源工具是客户端自注册的共享工具，两者不交叉
- 不把二进制资源内联进模型上下文：渲染时以说明文字替代 blob 内容，原始数据仍可供程序化调用方访问
- 不做资源的订阅或变更推送：本批次只做按需读取
- 不改 `startConnection` 的既有签名：本地比官方多 `sink` 与 `allowedTools` 两个参数，新能力挂在返回的 `ConnectionHandle` 上

## 影响

- `packages/mcp/mcp-resources/`：新增包（`src/index.ts`、`src/render.ts`、`src/tools.ts`、README.zh.md、测试）
- `packages/mcp/mcp-client/src/server-context.ts`：新增
- `packages/mcp/mcp-client/src/connection.ts`：`ConnectionHandle` 扩展为携带资源访问与指令读取；新增 `maxInstructionBytes` 配置
- `packages/mcp/mcp-client/src/index.ts`：调用 `registerServerContext`，两处 Config 分支各加 `maxInstructionBytes`
- `packages/core/system-prompt/src/index.ts`：`PromptSection` 与 `AssembledSection` 加 `interpolate?: boolean`，`renderPrompt` 加对应分支，`SECTION_ORDERS` 加 `MCP_SERVERS`
- `packages/bundle/base` 与 `packages/bundle/sdk-minimal`：挂载新包
- `tsconfig.base.json`、`tsconfig.host.json`：登记新包

本变更引入新的 `ctx` 服务与模型可见工具（新增 system prompt 段落与工具 schema 属于模型可见输入），并触及 system prompt 组装契约，定为 l2。

## 实施前置

本变更依赖两项独立能力，需先落地：

1. `PromptSection.interpolate` 字段：`mcp-resources` 与 `server-context` 都以 `interpolate: false` 注册段落，以保留指令文本中的 `{{braces}}` 字面量。本地当前无该字段，不补则编译失败；绕过类型则插值引擎会把花括号当作未知变量抛错
2. `SECTION_ORDERS.MCP_SERVERS` 常量：两个包都以 `getSectionOrder('MCP_SERVERS')` 取段落位置。本地 `SECTION_ORDERS` 在 `TOOL_REPORT: 2900` 之后直接跳到 `TOOLS_SDK: 5000`，缺该位置

两项都是 `packages/core/system-prompt` 的小改动，但属于该包的公开契约变更，需与本次一并记录。
