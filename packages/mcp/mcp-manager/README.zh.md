---
description: "用户管理的 MCP 服务器列表，挂载为 mcp-client 实例。"
---

# dsh-mcp-manager

`dsh-mcp-manager` 维护一份用户管理的 MCP 服务器列表，并为每个启用的条目挂载一个 `dsh-mcp-client` 实例。它是裸 mcp-client 插件的用户侧对应物：不再需要为每个服务器手写一行 `cordis.yml`，而是由一个配置界面读写单一的 `mcp` settings 段，manager 在每次变化时对活着的 mcp-client 集合做协调。当用户需要通过界面管理 MCP 服务器时添加它；默认不启用任何服务器，需要逐个选择加入。

## 配置

manager 注册 `mcp` settings 命名空间。该段是一个服务器条目列表；每个条目带有一个稳定的 `serverName`、一个 `enabled` 开关、一个传输方式及其字段：

```yaml
mcp:
  servers:
    - serverName: github
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env:
        GITHUB_TOKEN: 'your-token'
    - serverName: web
      transport: streamable-http
      url: http://localhost:3000/mcp
      headers:
        Authorization: 'Bearer token'
```

`env` 和 `headers` 的值是普通字段，而不是 `role('secret')`，因为列表是从 settings 线缆视图整体重写的——脱敏字段会在每次写入时被静默丢弃。其余字段是 `enabled`（默认 true）、传输方式、stdio 的 `command`/`args`/`cwd`，或 Streamable HTTP 的 `url`/`headers`。重连策略、单次调用超时和启动语义保持 mcp-client 的默认值。

`serverName` 必须匹配 `[A-Za-z0-9_-]{1,32}` 且在列表中唯一；重复会在写入时拒绝该段。禁用的条目保留其配置但不挂载实例，因此重新启用可恢复完全相同的工具集。

## 工作原理

manager 提供 `mcpStatusSink` 服务，每个挂载的 mcp-client 实例都会读取它，从而观察每台服务器的 `connecting` → `connected` → `reconnecting` → `failed` 生命周期。在 settings 变化时，它对前后两个列表做协调：先卸载（被删除、被禁用、以及启用但配置变化的条目），再挂载（新增、重新启用、以及变化的条目）。挂载失败会被遏制并记录日志，因此单个损坏的服务器绝不会阻塞它的同类。

裸 `dsh-mcp-client` 插件保持不变——每台服务器仍是一个稳定 `serverName` 下的 mcp-client 实例，仍通过 Cordis 的插件生命周期注册。manager 只改变了谁在何时创建和销毁这些实例：从启动时的 `cordis.yml` 行，变成运行时的 settings 变化。它还导出一个 `mcp` Remote 命名空间：`list()` 返回每台服务器的实时状态和工具名，`refresh(name)` 通过卸载并重挂其 mcp-client 实例来强制某台服务器重连。

## 相关文档

- [MCP 客户端插件](../mcp-client/README.md) —— manager 挂载的桥接。
- [MCP 包组](../README.md) —— 包组概览。
