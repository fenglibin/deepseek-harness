---
description: "挂载为存活 mcp-client 实例的用户管理 MCP 服务器列表：把一份 settings 命名空间在 Host 侧协调为每个已启用服务器一个桥接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

## 概述

`dsh-mcp-manager` 拥有一份用户管理的 MCP 服务器列表，并为每个已启用条目挂载一个 `dsh-mcp-client` 实例，在每次设置变更时协调存活实例集合。它是裸 mcp-client 插件面向用户的对应物：用户不需要为每个服务器手工编辑一行 `cordis.yml`，而是由配置界面读写单个 `mcp` settings 分节，manager 则挂载、丢弃或替换这些编辑所蕴含的桥接。它还通过 `mcp` Remote 命名空间报告每个服务器的实时连接状态、诊断文本与工具名，因此配置界面可以展示一次用户编辑究竟造成了什么。当 MCP 服务器属于运行时由用户管理的数据时加上它；默认什么都不启用，因此每个服务器都是一次显式选择。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把 `dsh-mcp-manager` 挂载进同时挂载了 `dsh-settings` 的 Host 组装，然后让用户通过配置界面添加服务器。每个已启用条目都会变成一个存活的 mcp-client 实例，模型可以以该服务器的名字调用它的工具。

### 何时选择它

当 MCP 服务器属于用户数据时选择 manager：它们会在进程运行期间变化、因用户而异，并且应由配置界面拥有。当服务器属于部署数据时选择裸 `dsh-mcp-client` 行——组装时固定、对所有用户一致，并且像其他 `cordis.yml` 条目一样被评审。两者并不互斥：一次部署可以既固定若干行，又允许用户自行添加，因为每个服务器都以自己的 `serverName` 划出命名空间。

### 最小配置

该插件不接受任何配置，作为一行组装挂载即可：

```yaml
- name: '@deepseek-ai/dsh-mcp-manager'
```

[配置目录](../../../docs/config-catalog.zh.md)中它没有列出任何字段：服务器列表是承载在 `mcp` 命名空间中的设置数据，不是插件配置。

### 服务器列表

`mcp` 命名空间持有一个 `servers` 数组。每个条目带有稳定的 `serverName`、一个 `enabled` 标志、一种传输方式，以及该传输方式对应的字段：

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

`serverName` 必须匹配 `[A-Za-z0-9_-]{1,32}` 且在列表内唯一；重名会在写入时、在任何东西持久化之前拒绝该分节。被禁用的条目保留其配置但不挂载实例，因此重新启用会恢复完全相同的工具集。`env` 与 `headers` 是普通字段而非 secret 角色字段，因为列表是从 settings 线缆视图整体编辑的，脱敏字段会在每次写入时被静默丢弃。重连策略、单次调用超时与启动语义沿用 mcp-client 的默认值。

### 协调过程

每次被接受的设置变更都会跑一轮协调：先丢弃、后挂载，因此在启用状态下发生变化的条目会先释放旧桥接，再由新桥接占用命名空间。挂载失败会被就地收容并记入日志，同时被记录为带诊断文本的 `failed` 状态，因此一个坏掉的服务器绝不会阻塞它的同伴，界面也能解释某个服务器为何始终没起来，而不是永远回答 `unknown`。

### 状态与 Remote 命名空间

manager 为配置界面导出一个 `mcp` Remote 命名空间。`list()` 为每个已配置服务器返回一行——它的连接状态、当前注册的工具名，以及存在失败时的最新失败文本；`refresh(name)` 通过丢弃并重新挂载实例来强制某个服务器重连。manager 还在每次状态迁移时发出一个不携带载荷的 `mcp/status` 事件，因此界面只需重新拉取，无需轮询。

### mcp.json 文档

manager 把一份 `mcp.json`（与其它主流 MCP 平台相同的跨厂商 `mcpServers` 结构）放在 settings 文档旁边，作为 MCP 的手动编辑入口。文件变化时，manager 先校验 JSON 格式，再把每个条目转换成 `servers` 数组，只在全部有效时才整体覆盖 `mcp` 命名空间；格式或条目非法时跳过同步并告警，settings 保留最后一份好文档。`disabled` 映射为 `enabled` 的取反，有 `command` 判为 stdio，有 `url` 判为 HTTP，`timeout` 与 `transportType` 被忽略。超出 `[A-Za-z0-9_-]{1,32}` 契约的服务器名会被哈希成稳定的 `mcp-<hex>` 名字，因此任何输入都能同步而不被拒绝。这份同步是单向且整节的：`mcp.json` 是手动编辑源，结构化表单的写入会在下一次 `mcp.json` 变化时被覆盖。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

manager 是建在两条 seam 上的一个服务：一条是它拥有的 settings 命名空间，另一条是为每个已启用条目挂载一次的 mcp-client 插件。

### settings 命名空间

该服务以 `applies: 'live'` 与一个 validate 钩子注册 `mcp`，因此变更会在运行中的进程里生效，而复用 `serverName` 的分节会在持久化之前被拒绝——schema 自身无法表达跨条目的唯一性。启动时会依据已存列表跑一次初始挂载，之后的每次变更都经由同一条串行协调链，因此初始挂载与设置驱动的挂载绝不会交错。

### 协调轮次

协调是纯函数：`reconcile(prev, next)` 返回一个有序动作列表，先丢弃后挂载，按 `serverName` 与条目值比较。条目在消失、被禁用、或在启用状态下发生变化时被丢弃；在新增、被重新启用、或发生变化时被挂载。服务按顺序执行这些动作，并让协调链尾在失败后继续存活，因此一次被拒绝的挂载绝不会让下一次协调卡死。

### 状态 sink

该服务提供 `mcpStatusSink`——每个挂载的 mcp-client 实例所读取的 sink，并按 `serverName` 记录每次上报。它自己的拆除信号并不是一种连接状态，因此 `disposed` 上报会被丢弃，而状态会在 manager 丢弃某个服务器时被清除。一次上报还会发出 `mcp/status`；由于 manager 会收容并记录 sink 失败，抛错的监听器无法破坏它只是旁观的那个重连循环。

### mcp.json 同步

当 settings provider 是文件类型时，manager 解析出 `mcp.json` 的路径（settings 文档同目录），先播种缺失的文档，再用 chokidar 监听它的变化。每次变化走一条单向路径：`readFile` → `parseMcpJson`（JSON 语法与 `mcpServers` 结构校验）→ `mcpJsonToSettings`（`mcpServers` map 到 `servers` 数组，`disabled` 取反、`command`/`url` 判别传输）→ `SettingsScope.replace`。任一步失败都会被记录并跳过，绝不会把半成品写进 settings；转换本身是纯函数，集中在 `mcp-json.ts`。文档缺失时，`bootstrapMcpJson` 从当前 `scope.get()` 反向渲染一份 `mcp.json`，因此首次手动编辑从 settings 已有的内容开始。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖每个条目所变成的桥接、编辑这份列表的浏览器界面，以及其背后的持久化设置 seam。

- [mcp-client](../mcp-client/README.zh.md)——manager 为每个已启用条目挂载的桥接。
- [ui-settings-mcp](../../client/ui-settings-mcp/README.zh.md)——编辑该命名空间的浏览器界面。
- [settings](../../settings/README.zh.md)——承载服务器列表的持久化用户设置 seam。
- [tools](../../core/tools/README.zh.md)——每个挂载桥接所注册进入的工具注册表。
- [MCP 包组](../README.zh.md)——包组概览。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 manager 挂载的那些 mcp-client 实例：它们拥有以用户选定的服务器名注册的全部 `mcp__<serverName>__<rawName>` 工具 schema、描述与结果。

#### KV Cache 影响

一次服务器列表编辑会改变该会话中每个后续请求的前缀，因为挂载或丢弃一个服务器会增加或移除该服务器所拥有的工具定义；manager 自身不写入任何模型可见的内容，而一轮协调为空操作的编辑则不会触碰前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了 manager 能协调什么、以及配置界面能从中了解到什么；它们是当前包约束。

- **服务器面向整个用户，而非按会话**——列表存在于一份设置文档中，因此用户添加的条目对该进程服务的每个会话都可见；不存在按会话或按项目的服务器列表。
- **没有 secret 角色字段**——`env` 与 `headers` 以纯文本存储，因为列表是从线缆视图整体编辑的；需要这些值在静态存储时脱敏的部署，必须不把它们放进本命名空间。
- **重连策略在此处不可配置**——退避、尝试次数上限与单次调用超时沿用 mcp-client 的默认值，因此调整某个服务器的韧性意味着配置它自己的条目，而非 manager。
- **状态是最近一次已知值，而非实时推送**——`mcp/status` 事件不携带载荷，界面因此在收到事件后重读 `list()`；与重新拉取竞争的状态迁移，要等下一次事件或刷新才可见。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
