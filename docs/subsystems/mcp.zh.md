# MCP 服务器管理

用户管理的 MCP 服务器列表，以及每个已启用条目所变成的桥接实例。[`dsh-mcp-client`](../../packages/mcp/mcp-client/README.zh.md) 拥有一台服务器的连接与它所注册的工具；本页覆盖它之上的那一层：持有列表的 settings 命名空间、把一次列表编辑翻译成挂载与丢弃动作的协调过程，以及配置界面回读的状态。

## 服务器列表

`mcp` settings 命名空间持有一个 `servers` 数组，并以 `applies: 'live'` 注册，因此一次编辑会在运行中的进程里生效。每个 `McpServerEntry` 要么是 stdio 服务器（`command`、`args`、`env`、`cwd`），要么是 Streamable HTTP 服务器（`url`、`headers`），由 `transport` 判别；每个条目还带有稳定的 `serverName`——它为工具划出命名空间——以及决定 manager 是否挂载它的 `enabled` 标志。`serverName` 必须匹配 `[A-Za-z0-9_-]{1,32}` 且在列表内唯一——这一约束 schema 自身无法表达，因此命名空间的 validate 钩子会在任何东西持久化之前拒绝重名的分节。

## 协调过程

一次列表编辑会跑一轮协调：先丢弃、后挂载，因此在启用状态下发生变化的条目会先释放旧桥接，再由新桥接占用命名空间。条目在消失、被禁用、或在启用状态下发生变化时被丢弃；在新增、被重新启用、或发生变化时被挂载。挂载失败会被就地收容并记录，而不是向外传播，因此一个坏掉的服务器绝不会阻塞它的同伴。

## 状态与 Remote 命名空间

manager 提供 `mcpStatusSink`——每个挂载的 mcp-client 实例向它上报连接状态——并按 `serverName` 保留最近一次上报。它自己的拆除信号并不是一种连接状态，因此 `disposed` 上报会被丢弃，而状态会在某个服务器被丢弃时清除。`McpServerStatusView` 是配置界面读取的客户端安全行：服务器名、连接状态、当前注册在它名下的工具名，以及存在失败时的最新失败文本。

## 事件

`mcp/status` 是在每次连接状态迁移时发出的 Host 侧通知。它按设计不携带载荷：配置界面会重新读取 manager 的 `list` Remote 方法以获取新状态，而不是信任一份推送来的快照，因此一次丢失或乱序的读取不会在屏幕上留下过期的行。

## 服务行为

[`McpManager`](../../packages/mcp/mcp-manager/src/manager.ts) 挂载并协调这些桥接，同时提供 `mcp` Remote 命名空间；它依赖 `dsh-settings`，且不注册自己的任何配置。该包 [README](../../packages/mcp/mcp-manager/README.zh.md) 定义了命名空间、协调规则与 Remote 方法。[tools 子系统](tools.zh.md)拥有每个挂载桥接向模型注册进去的那部分。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="mcp-events"></a>

### `mcp/*` events

<a id="mcpstatus--emit"></a>

#### `mcp/status` — emit

One server's live connection status changed. Payload-free: a configuration surface re-reads the manager's `list` Remote method for the new state.

```ts cordis-catalog
/**
 * One server's live connection status changed. Payload-free: a
 * configuration surface re-reads the manager's `list` Remote method for
 * the new state.
 * @mode emit
 */
'mcp/status'(): void
```

Source: [`packages/mcp/mcp-manager/src/status.ts`](../../packages/mcp/mcp-manager/src/status.ts)
<!-- END GENERATED cordis-surface -->
