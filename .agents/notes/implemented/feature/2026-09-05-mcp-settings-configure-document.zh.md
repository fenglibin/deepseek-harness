# Agent Note：MCP 设置分区「配置MCP」打开单向同步的 mcp.json

状态：已实现

## 问题

MCP 设置分区只有结构化表单，唯一能提供的手动编辑入口是共享的 `settings.yaml`——一个把每个命名空间混在一起的文件，所以只想改一个 MCP 服务器的用户必须先读懂整个文件。而每个主流 MCP 平台都会发布一份聚焦的、跨厂商 `mcpServers` 结构的 `mcp.json`，因此没有一个单一、熟悉的入口来维护 MCP。

## 决策

新增一个 **配置MCP** 按钮，打开一份放在 `settings.yaml` 旁边的专用 `mcp.json`（跨厂商 `mcpServers` map），并把它单向同步进 `mcp` settings 命名空间。文件变化时，manager 解析该文件、转换成命名空间的 `servers` 数组，并且只有在 JSON 格式正确、每个条目都能转换时，才通过 `SettingsScope.replace` 整体覆盖该命名空间。缺失的文档会在首次打开时从当前 settings 分区播种。`disabled` 映射为 `enabled` 的取反；有 `command` 是 stdio 条目，有 `url` 是 HTTP 条目；`timeout` 与 `transportType` 是 dsh 不管理的字段，予以忽略。超出 `[A-Za-z0-9_-]{1,32}` 契约的服务器名会被哈希成一个稳定的 `mcp-<sha256 hex>` 名字，而不是拒绝整个文档，因此每个用户的输入都能运行。同步是单向且整节的：`mcp.json` 是手动编辑源，下一次 `mcp.json` 变化会覆盖结构化表单的写入。

## 考虑过的替代方案

- 直接打开 `settings.yaml`——否决；用户的抱怨恰恰是「整个文件是错误的编辑面」。
- 双向同步——否决；它会重新引入单向设计刻意避免的双源一致性问题。
- 让 settings 支持多文档——否决；这要改动 settings seam 的单文档核心，远超本功能范围。

## 后果

MCP 现在有一个聚焦的、符合业界惯例的编辑入口，而 `settings.yaml` 仍是运行时权威；manager 的 reconcile/watch 路径保持不变，因为同步走的是 `SettingsScope.replace`，会经既有 commit 扇出。格式错误或非法的 `mcp.json` 永远不会到达 settings——它会被记录日志并留给用户修正。

## 风险

- 单向覆盖意味着通过结构化表单新增的服务器，会在下一次编辑并保存一份过期的 `mcp.json` 时丢失。
- 超出 dsh `[A-Za-z0-9_-]{1,32}` 契约的服务器名会被哈希成稳定的 `mcp-<hex>` 名字而非保留，因此 settings 里的映射名字与用户在 `mcp.json` 里写的不同。
