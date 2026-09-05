---
description: "dsh Web 客户端的 MCP 服务器设置分区：在 Host 拥有的 mcp settings 命名空间上，对用户管理的 MCP 服务器列表执行添加、编辑、删除与启用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

## 概述

`dsh-client-ui-settings-mcp` 是 dsh Web 客户端的 **MCP** 设置分区：用户在此添加、编辑、删除并启用模型可以调用其工具的 MCP 服务器。这份列表是 Host 端 `dsh-mcp-manager` 插件所拥有的 `mcp` settings 命名空间中的一个 `servers` 数组，因此本包不注册自己的命名空间——它绑定该命名空间，并且每次变更都以一次受修订号栅栏保护的 mutation 整体重写这个数组。每一行展示服务器的名称、命令或 URL、一个实时状态圆点，以及 manager 当前为它报告的工具数量；新增或编辑只会打开一个弹窗，暂存单个条目、仅在保存时写入，而行内的开关则立即写入，因为启用是一个单一的可见决定。当 MCP 服务器应由用户在浏览器中管理时选择本包；每个条目最终挂载什么，只有 Host manager 说了算。

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

打开设置中的 **MCP**，即可看到每个已配置的服务器、它的传输方式、实时连接状态，以及它注册了多少工具。**添加服务器**打开一个用于新建条目的弹窗，**编辑**在已有条目上重新打开该弹窗，**删除**在确认后移除条目，行内开关启用或禁用它，**刷新**则强制一个正在运行的服务器重连。

### 何时选择它

把本包挂载进同时挂载了 `dsh-mcp-manager` 与 `dsh-client-ui-settings` 的 Web 组装中。它编辑的是一个并不属于它的命名空间：没有 Host manager 时，本分区没有可绑定的对象，只会渲染空列表；没有设置外壳时，则没有承载它的分区。通过 `cordis.yml` 行管理全部 MCP 服务器的部署，本包与 manager 都不需要。

### 最小配置

该插件不接受任何配置，作为一行组装挂载即可：

```yaml
- name: '@deepseek-ai/dsh-client-ui-settings-mcp'
```

[配置目录](../../../docs/config-catalog.zh.md)中它没有列出任何字段：用户改动的一切都落在 Host 拥有的 `mcp` settings 命名空间里。

### 编辑与保存

弹窗暂存单个条目，只有保存时才写入。新建条目的 `serverName` 必须匹配 `[A-Za-z0-9_-]{1,32}`，且在列表内唯一；分区会在写入前拒绝重名，并保持弹窗打开。条目一旦存在，其 `serverName` 即为只读，因为 manager 与每个工具名都以它为键。stdio 条目需要命令、空格分隔的参数、工作目录，以及每行一个 `KEY=value` 的环境变量；Streamable HTTP 条目需要 URL，以及每行一个 `Header: value` 的请求头。这两个映射是普通字段而非 secret 角色字段，因为列表是从线缆视图整体重写的，脱敏字段会在每次写入时被静默丢弃。

### 实时状态

每行圆点先看服务器的启用开关，再看 manager 报告的连接状态：条目关闭时为 `disabled`，否则为 `connecting` 或 `reconnecting`、`connected`、`failed`，或在服务器尚未报告时为 `unknown`。服务器列表变化、以及 manager 推送 `mcp/status` 事件时，分区都会重新拉取状态，因此新挂载服务器的状态无需手动刷新就会出现。**刷新**会丢弃该服务器当前的桥接实例并挂载一个新的，然后重新拉取，使行内显示新的状态与工具数量。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本分区是一次 slot 贡献，建立在三个注入的服务之上：绑定到 Host 拥有的 settings 命名空间的服务器列表 store、位于 Host `mcp` Remote 命名空间之上的状态 store，以及承载其文案的 locale 词典。

### 分区注册

浏览器半侧以 id `mcp`、order 20 注册 `settings.section`，因此设置外壳会把它排在声明了更小 order 的条目之后。它的 node 半侧是一个空 `apply`：插件会出现在 Loader 中并发布一份浏览器 bundle，但不拥有任何宿主侧行为。本包不注册 settings 命名空间——`ctx.settingsScope.bind({ namespace: 'mcp' })` 直接到达 Host manager 注册的那个分区。

### 写入路径

列表是一个数组，因此每次被接受的变更都会以一次 mutation 整体重写它，并以 store 最近读到的命名空间 revision 设栅：添加、更新、删除与启用最终都归结为在该 revision 上对 `servers` 的一次 `set`。落在已移动 revision 上的写入、面向只读文档的写入，或在另一次保存正在过线时到达的写入，都会被拒绝并报告，而不是覆盖更新的答案。store 自己维护 `saving` 与 `failed` 两个标志，并在每次变化时重新发布一份快照，因此行内容、进行中状态与失败提示都读自同一来源。

### 状态叠加层

状态 store 按需拉取 manager 的 `list` Remote 方法，并订阅推送来的 `mcp/status` 事件以重新拉取。已在飞行中的拉取绝不会叠加：期间到达的推送事件会置起一个重载标志，由飞行中的那次拉取在落定时兑现。`refresh(name)` 请求 manager 丢弃该服务器当前的 mcp-client 实例并挂载一个新的，然后重新拉取，使行内显示新的连接状态与工具名。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置底座、拥有该命名空间的 Host manager，以及每个条目所变成的桥接。

- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.section` 与 settings scope 的领域底座。
- [mcp-manager](../../mcp/mcp-manager/README.zh.md)——拥有 `mcp` 命名空间并挂载每个条目的 Host 插件。
- [mcp-client](../../mcp/mcp-client/README.zh.md)——每个已启用条目所变成的桥接。
- [settings](../../settings/README.zh.md)——每个命名空间背后的持久化用户设置 seam。
- [MCP 包组](../../mcp/README.zh.md)——包组概览。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端设置界面，不注册任何面向模型的表面。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了本分区能展示什么、以及何时拒绝写入；它们是当前包约束。

- **命名空间归 Host 所有**——本包只渲染 `mcp` 分区中的内容并经由它写入，因此从未挂载 `dsh-mcp-manager` 的组装会看到空列表，而不是一份本地草稿。
- **没有 secret 角色字段**——`env` 与 `headers` 以纯文本编辑与存储，因为列表是从线缆视图整体重写的；需要这些值在静态存储时脱敏的部署，必须不把它们放进本分区。
- **状态靠重新拉取，而非流式推送**——`mcp/status` 事件不携带载荷，因此分区在列表变化或收到推送事件后重读每个服务器的状态；manager 从未推送的状态迁移，要等下一次重新拉取或手动刷新才可见。
- **一次只能一次写入**——另一次保存正在过线时，store 会拒绝新的变更，因此两次快速编辑由先到达线缆的那一次串行决定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
