---
description: "MCP 服务器设置界面：用户管理的 MCP 服务器列表，支持添加、编辑、删除与启用。"
---

# dsh-client-ui-settings-mcp

`dsh-client-ui-settings-mcp` 在设置外壳中渲染 MCP 导航条目：一个用户可以添加、编辑、删除和启用的服务器列表，底层是 Host 端 `dsh-mcp-manager` 插件所拥有的 `mcp` settings 命名空间。它是一个纯界面包——node 半边是空 apply 以便插件出现在 Loader 中，browser 半边注册 `settings.section` 条目和绑定到该命名空间的 store。Host 端 manager 把每一次 settings 变化协调为 mcp-client 实例；本包只负责写入列表。

## 它编辑什么

`mcp` 命名空间持有一个 `servers` 数组。每个条目要么是 stdio 服务器（`serverName`、`enabled`、`transport: 'stdio'`、`command`、`args`、`env`、`cwd`），要么是 Streamable HTTP 服务器（`serverName`、`enabled`、`transport: 'streamable-http'`、`url`、`headers`）。弹窗先暂存一个条目、仅在保存时写入；启用开关因为是单一的可见决定，所以立即写入。

`env` 和 `headers` 映射以每行一个 `KEY=value`（或 `Header: value`）的形式编辑。它们是普通字段，而不是 `role('secret')`，因为列表是从 settings 线缆视图整体重写的——脱敏字段会在每次写入时被静默丢弃。

## 工作原理

该 section 在 `mcp` 命名空间上绑定一个 `SettingsScope`，并发布列表渲染所用的快照。每次添加、删除、更新和启用都以一次受修订号栅栏保护的 mutation 整体重写 `servers` 数组；落在已移动修订号上的写入会失败，而不是覆盖更新的答案。`serverName` 是 manager 和每个工具名所依赖的稳定身份，因此一旦条目存在就只读。

## 相关文档

- [MCP manager](../mcp/mcp-manager/README.zh.md) —— 把每个条目挂载为 mcp-client 实例的 Host 插件。
- [MCP client](../mcp/mcp-client/README.zh.md) —— 每个条目所变成的桥接。
- [MCP 包组](../mcp/README.zh.md) —— 包组概览。
