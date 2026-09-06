# Agent Note: MCP 配置解析不向冻结快照回写

Status: implemented

## Problem

通过 MCP 设置界面添加一个带 `env` 或 `args` 的 stdio 服务器（例如 `uvx --from mysql-mcp-server mysql_mcp_server` 配一组 `MYSQL_*` 环境变量）后，服务器状态显示 `failed`，错误是 Schemastery 的 `ValidationError: expected { transport?: "stdio", … } | { transport?: "streamable-http", … } but got {…}`——输入字段全都符合 schema，却仍被 union 拒绝。

根因链：`ctx.settings.get()` 返回的是一份冻结（frozen）快照，`McpManager.toMcpClientConfig`（`packages/mcp/mcp-manager/src/manager.ts`）把 `server.args`、`server.env`、`server.headers` 的引用原样交给 `McpClient.Config` 解析。Schemastery 的 `dict`/`array` resolver 在规范化时会原地回写输入对象（`data[rKey] = data[key]`、`property` 里的 `data[key] = adapted`）。在冻结对象上，这种回写在 ESM 严格模式下抛出 `TypeError`，被 union resolver 的逐个分支 `try/catch` 吞掉，两个分支于是都「失败」，最终报出与实际字段内容无关的 `expected … but got …`。纯文本环境（`env: {}`、`args: []`）不会踩中，因为空集合无需回写；一旦集合非空就必然触发。

## Decision

`toMcpClientConfig` 在构造 mcp-client 配置前对 `args`、`env`、`headers` 做浅拷贝（`[...server.args]`、`{ ...server.env }`、`{ ...server.headers }`）。这些集合的元素都是字符串，浅拷贝足以让 Schemastery 的回写落到一份可变的副本上，而不会触碰设置文档的冻结快照。

## Alternatives considered

**在 Schemastery 里让 dict/array resolver 不再回写输入。** 否决：回写是 Schemastery 对所有 schema 的通用规范化行为，改动 vendor 会波及全仓库，且冻结快照本身就是设置层防止意外修改的契约，问题只出在「把冻结引用交给会回写的解析器」这一处调用点。

**在 `McpManager` 读取 settings 时深拷贝整个 section。** 否决：把整份服务器列表深拷贝会在每次 mount 时引入不必要的开销，而只有会被 Schema 回写的集合字段需要隔离。

**让 mcp-client 的 `Config` 在解析前自行克隆。** 否决：`Config` 是纯 schema，不应承担输入对象所有权的假设；调用方（manager）知道自己传的是冻结快照，就地隔离是唯一知道这一事实的层级。

## Consequences

带 `env`/`args`/`headers` 的 MCP 服务器现在能正常挂载并上报 `connected`，不再因冻结回写而报出误导性的 `ValidationError`。`packages/mcp/mcp-manager/tests/manager.spec.ts` 新增「mounts a stdio server carrying args and env values」回归用例，用真实的 `uvx` + `MYSQL_*` 配置走完整的 settings 写入 → mount 路径锁定行为。
