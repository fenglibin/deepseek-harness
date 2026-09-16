# 实施清单

## 1. system prompt 前置能力

- [x] 1.1 在 `packages/core/system-prompt/src/index.ts` 的 `PromptSection` 新增可选 `interpolate?: boolean` 字段，JSDoc 说明缺省为 `true`、设为 `false` 时文本作为字面量 (covers: mcp-resources/system prompt 段落可以退出变量插值, design/D1)
- [x] 1.2 在同一文件的 `AssembledSection` 新增同名可选字段，并在组装处透传 (covers: mcp-resources/system prompt 段落可以退出变量插值, design/D1)
- [x] 1.3 在 `renderPrompt` 中按 `section.interpolate === false` 分支直接取原文，否则走既有插值路径 (covers: mcp-resources/关闭插值的段落保留花括号字面量, mcp-resources/省略插值字段的段落行为不变, design/D1)
- [x] 1.4 在 `SECTION_ORDERS` 中新增 `MCP_SERVERS: 3100`，位置在 `TOOL_REPORT: 2900` 与 `TOOLS_SDK: 5000` 之间 (covers: mcp-resources/段落位置包含 MCP 服务器区段, design/D1)

## 2. mcp-resources 包

- [x] 2.1 新建 `packages/mcp/mcp-resources/`，含 `package.json`（peer 依赖 `dsh-llm`、`dsh-scope`、`dsh-system-prompt`、`dsh-tools`、`cordis`）、`tsconfig.json`、README.zh.md (covers: mcp-resources/MCP 资源按作用域可访问, design/D2)
- [x] 2.2 定义 `McpResourceRequest` 判别联合（`resources/list`、`resources/templates/list`、`resources/read`）与 `McpResourceProvider` 接口 (covers: mcp-resources/MCP 资源按作用域可访问, design/D2)
- [x] 2.3 实现 `McpResourceRuntime`：用 `ScopedLayers` 与 `NamedEntries` 维护按作用域的服务提供方集合，`register` 拒绝重复名并随作用域释放撤销，请求时用 `exec.agent` 合并作用域链查找 (covers: mcp-resources/注册服务器资源访问, mcp-resources/同作用域重复注册被拒绝, mcp-resources/不可用的服务器名在请求前失败, design/D2)
- [x] 2.4 实现工具随提供方存活：首个提供方注册时经 `registerResourceTools` 注册三个工具，最后一个卸载时移除 (covers: mcp-resources/三个共享资源工具随提供方存活, mcp-resources/无提供方时工具不存在, mcp-resources/首个提供方使工具出现, mcp-resources/最后一个提供方卸载时工具移除, design/D3)
- [x] 2.5 注册名为 `mcp-resource-servers` 的 system prompt 段落，位置取 `getSectionOrder('MCP_SERVERS')`，`interpolate: false`，文本列出当前作用域可见的服务器名 (covers: mcp-resources/服务器指令作为独立段落注入, design/D3, design/D5)
- [x] 2.6 实现 `src/render.ts` 的 `renderResourceResult`：把 `blob` 键的字符串值替换为含长度的说明文字，结果前缀标明来源服务器 (covers: mcp-resources/二进制载荷以说明文字呈现, mcp-resources/结果标明来源服务器, design/D4)
- [x] 2.7 实现 `src/tools.ts` 的 `registerResourceTools`：用 `defineTool` 注册三个工具，各自 schema 要求必填 `server` 参数，输出经 `renderResourceResult` 渲染 (covers: mcp-resources/三个共享资源工具随提供方存活, mcp-resources/缺少服务器参数在派发前失败, mcp-resources/调用时才读取, design/D3)
- [x] 2.8 补 `src/invariant.ts` 伴生入口，检查作用域提供方集合与工具注册的配对关系 (covers: mcp-resources/MCP 资源按作用域可访问)

## 3. mcp-client 接线

- [x] 3.1 新增 `packages/mcp/mcp-client/src/server-context.ts`：定义 `ServerContext` 接口（`resources` 与 `instructions()`），实现 `registerServerContext` 经 `ctx.inject(['mcpResources'])` 注册资源、经 `ctx.inject(['systemPrompt'])` 注册名为 `mcp:<server>` 的段落 (covers: mcp-resources/资源能力以可选服务注入, mcp-resources/服务器指令作为独立段落注入, design/D5, design/D6)
- [x] 3.2 在 `packages/mcp/mcp-client/src/connection.ts` 中让 `ConnectionHandle` 携带资源访问与指令读取，指令在连接成功时设置、失败/断开/释放时清空为空字符串 (covers: mcp-resources/连接成功后注入指令, mcp-resources/断开后指令撤回, mcp-resources/未提供指令时不留下空段落, design/D5)
- [x] 3.3 在该文件实现 `resources.request` 的方法分派（`resources/list`、`resources/templates/list`、`resources/read`），并在连接未建立时抛出说明断开的错误；以 `assertNever` 收尾判别联合 (covers: mcp-resources/调用时才读取, mcp-resources/不可用的服务器名在请求前失败, design/D2)
- [x] 3.4 新增 `DEFAULT_MAX_INSTRUCTION_BYTES`（32768）与 `maxInstructionBytes` 配置项，超限时使该次连接失败而非截断 (covers: mcp-resources/指令超过上限时连接失败, design/D5)
- [x] 3.5 在 `packages/mcp/mcp-client/src/index.ts` 的 `apply` 中调用 `registerServerContext(ctx, config.serverName, connection)`；在两处 Config 分支各加 `maxInstructionBytes` 字段 (covers: mcp-resources/连接成功后注入指令, mcp-resources/资源能力以可选服务注入, design/D6)
- [x] 3.6 确认 `startConnection` 的既有五参数签名不变（本地比官方多 `sink` 与 `allowedTools`），新能力只挂在返回的 handle 上 (covers: mcp-resources/资源能力以可选服务注入, design/D7)
- [x] 3.7 在 `packages/mcp/mcp-client/package.json` 的 peer 与 dev 依赖中新增 `dsh-mcp-resources` 与 `dsh-system-prompt`；在 `tsconfig.json` 的 references 中登记两者 (covers: mcp-resources/资源能力以可选服务注入, design/D6)
- [x] 3.8 确认本地 `@modelcontextprotocol/sdk` 1.29.0 的 `Client` 已提供 `listResources`、`listResourceTemplates`、`readResource` 与 `getInstructions`，本变更不升级 SDK；若某方法缺失则记录为阻塞项而非就地升级 (covers: mcp-resources/资源读取按需执行且二进制不内联, design/D8)

## 4. 装配与工程

- [x] 4.1 在 `packages/bundle/base/cordis.patch.yml` 挂载 `@deepseek-ai/dsh-mcp-resources`，并在其 `package.json` 添加依赖 (covers: mcp-resources/三个共享资源工具随提供方存活, design/D6)
- [x] 4.2 在 `packages/bundle/sdk-minimal/cordis.patch.yml` 与 `package.json` 做同样挂载 (covers: mcp-resources/三个共享资源工具随提供方存活, design/D6)
- [x] 4.3 在 `tsconfig.base.json` 的 paths 与 `tsconfig.host.json` 的 references 中登记 `packages/mcp/mcp-resources` (covers: mcp-resources/MCP 资源按作用域可访问)

## 5. 测试

- [x] 5.1 新增 `packages/core/system-prompt` 用例：`interpolate: false` 的段落保留花括号字面量、省略该字段的段落照常插值、`getSectionOrder('MCP_SERVERS')` 可解析且小于 `TOOLS_SDK` (covers: mcp-resources/关闭插值的段落保留花括号字面量, mcp-resources/省略插值字段的段落行为不变, mcp-resources/段落位置包含 MCP 服务器区段, design/D1)
- [x] 5.2 新增 `packages/mcp/mcp-resources/tests/resources.spec.ts`：覆盖无提供方时工具不存在、首个提供方使工具出现、最后一个卸载时移除、跨作用域可见性、同作用域重复注册被拒、不可用服务器名在请求前失败 (covers: mcp-resources/无提供方时工具不存在, mcp-resources/首个提供方使工具出现, mcp-resources/最后一个提供方卸载时工具移除, mcp-resources/同作用域重复注册被拒绝, mcp-resources/不可用的服务器名在请求前失败, design/D2, design/D3)
- [x] 5.3 在同一 spec 覆盖三个工具的 schema 与派发：缺 `server` 参数在派发前失败、`read_mcp_resource` 的 `uri` 透传、游标透传、二进制载荷以说明文字呈现而原始数据保留 (covers: mcp-resources/缺少服务器参数在派发前失败, mcp-resources/二进制载荷以说明文字呈现, mcp-resources/结果标明来源服务器, mcp-resources/调用时才读取, design/D4)
- [x] 5.4 新增 `packages/mcp/mcp-client/tests/server-context.spec.ts`：覆盖字面量指令注入与随作用域释放撤回、作用域隔离、未提供指令时不产生段落 (covers: mcp-resources/连接成功后注入指令, mcp-resources/未提供指令时不留下空段落, mcp-resources/断开后指令撤回, design/D5)
- [x] 5.5 在 `packages/mcp/mcp-client/tests/` 补充用例：未挂载资源包时客户端仍工作、白名单只过滤服务器自报工具、超限指令使连接失败 (covers: mcp-resources/未挂载资源包时客户端仍工作, mcp-resources/资源工具不受工具白名单影响, mcp-resources/指令超过上限时连接失败, design/D6, design/D7)
- [x] 5.6 新增确定性 resources fixture 服务器（含文本资源、二进制资源、URI 模板与字面量 instructions），供上述用例复用 (covers: mcp-resources/调用时才读取, mcp-resources/连接成功后注入指令)
- [x] 5.6b 新增真实 stdio MCP 服务器的端到端用例（`packages/mcp/mcp-client/tests/resources-server.e2e.spec.ts`）：经 `dsh-mcp-client` 连上 `fixtures/resources-server.ts` 子进程，断言三个工具读到资源、二进制以说明文字呈现且 base64 不外泄、URI 模板展开可读、缺服务器参数失败、instructions 以字面量段落进入系统提示词 (covers: mcp-resources/调用时才读取, mcp-resources/二进制载荷以说明文字呈现, mcp-resources/结果标明来源服务器, mcp-resources/连接成功后注入指令, mcp-resources/MCP 资源按作用域可访问)
- [x] 5.7 新增会话快照场景 `snapshots/session/mcp-resources/`：一个挂载 resources 能力的组合，固定模型可见的工具 schema 与系统提示词段落 (covers: mcp-resources/三个共享资源工具随提供方存活, mcp-resources/服务器指令作为独立段落注入)

## 6. 文档

- [x] 6.1 编写 `packages/mcp/mcp-resources/README.zh.md`：服务契约、三个工具的 schema 与语义、作用域解析、二进制渲染取舍，以及"已知限制与延期工作"（不支持 Prompts、不支持订阅推送、需显式服务器名） (covers: design/D2, design/D3, design/D4)
- [x] 6.2 更新 `packages/mcp/mcp-client/README.zh.md`：记录资源访问与指令注入、`maxInstructionBytes` 配置、以及"未挂载资源包时行为不变" (covers: mcp-resources/资源能力以可选服务注入, mcp-resources/指令超过上限时连接失败, design/D5, design/D6)
- [x] 6.3 更新 `packages/core/system-prompt/README.zh.md` 与其子系统页，记录 `interpolate` 字段与 `MCP_SERVERS` 段落位置 (covers: mcp-resources/system prompt 段落可以退出变量插值, mcp-resources/段落位置包含 MCP 服务器区段, design/D1)
- [x] 6.4 更新 `docs/tool-catalog.zh.md` 与 `docs/config-catalog.zh.md` 的生成物（重跑对应生成器） (covers: mcp-resources/三个共享资源工具随提供方存活)
- [x] 6.5 新增 Agent Note 记录"三个工具随提供方存活"与"指令超限失败而非截断"两项决策 (covers: design/D3, design/D5)
