---
description: "面向部署方与维护者的 MCP 资源说明：三个共享工具、按作用域的服务器可见性、二进制载荷的渲染取舍。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-resources

## 概述

`dsh-mcp-resources` 让模型发现并读取已配置 MCP 服务器提供的文档与结构化数据。挂载它之后，只要调用方作用域内存在已配置的 MCP 服务器，就自动提供三个共享工具。每个工具都要求显式指定服务器名，且只在调用时读取内容。资源文本进入对话历史；二进制载荷仍保留在工具结果 JSON 中供程序化调用方使用，在模型可见文本里替换为说明文字。主要成本是三个工具 schema 的固定 token 开销，以及按需读取返回的内容。

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

随附 profile（`base` 与 `sdk-minimal`）已经各挂载本包一次。你只需为所需服务器配置 [MCP 客户端](../mcp-client/README.zh.md)条目。

### 服务器配置

通过[客户端配置](../mcp-client/README.zh.md#use-this-package)在目标作用域中添加服务器。本包没有配置字段。

调用方没有已配置 MCP 服务器时，看不到 MCP 资源工具，提示词里也不会有服务器名称段落。配置服务器后三个共享资源工具即出现，包括由其他提供方挂载客户端、以及自身没有工具或指令的服务器。只要客户端条目保持激活，连接失败就不会移除共享工具；资源调用会报告连接错误。

### 发现与读取

如果组合挂载了 system prompt 服务，提示词会列出调用 agent 可见的服务器名。把其中一个名字作为 `server` 参数调用 `list_mcp_resources` 或 `list_mcp_resource_templates`。不传游标时 MCP SDK 收集服务器的全部分页；显式传 `cursor` 时返回一页，把返回的 `nextCursor` 原样作为下一次的 `cursor` 传入即可请求下一页。用同样的 `server` 名加上显式 `uri`，通过 `read_mcp_resource` 读取已列出的 URI 或展开后的模板。

每个操作都在**调用 agent 的作用域**内解析服务器。缺少 `server` 参数或服务器在该作用域不可用时，请求在派发前失败，不发起任何网络操作。连接所有者负责请求取消、超时与恢复；失败的请求仍表现为失败的工具调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 服务契约

`ctx.mcpResources` 提供 `register(server, provider)`：每个已配置服务器的连接在其作用域内注册一次，注册随该作用域释放而撤销。同一作用域内重复注册同一个服务器名会抛错。提供方的 `request(request, exec)` 在存活的连接代际上执行一次操作，`request` 是判别联合（`resources/list`、`resources/templates/list`、`resources/read`）。

### 工具随提供方存活

三个工具是**共享的**：它们不属于任何单个服务器，而是按 `server` 参数分派。因此注册时机由作用域内的提供方数量决定——首个提供方注册时注册全部三个工具，最后一个提供方卸载时移除它们。这既避免了"没有服务器时也暴露三个必然失败的工具"，也让工具 schema 只在真正有用时进入提示词。资源服务独立于首个提供方插件拥有这组共享工具 effect，因此卸载该提供方不会移除其他服务器仍需要的工具。共享工具注册失败时整组回滚，不留下半个工具集。

### 渲染

规范结果（`JsonValue`）保留完整 JSON 供程序化调用方使用。模型可见文本前缀 `MCP server: <server>` 标明来源，并把字符串值的 `blob` 字段替换为说明其 base64 长度的文字；URI、MIME 类型与文本字段仍保留在渲染后的 JSON 中。工具流水线负责记录结果。服务器指令归 MCP 客户端及其段落所有，不在本包。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 按作用域的提供方选择与服务器名提示词段落 |
| [`src/tools.ts`](src/tools.ts) | 三个共享资源工具与参数 schema |
| [`src/render.ts`](src/render.ts) | 带来源标注且不内联二进制载荷的文本投影 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面介绍服务器配置、执行机制与相邻机制。

- [MCP 客户端](../mcp-client/README.zh.md)——服务器传输、指令注入与连接生命周期。
- [系统提示词](../../core/system-prompt/README.zh.md)——段落位置与 `interpolate` 字段。
- [工具子系统](../../../docs/subsystems/tools.zh.md)——规范值与模型可见结果。

-----

<a id="model-experience"></a>
## 模型体验

### 共享资源工具

#### 模型看到什么

调用方可见的已配置服务器共享三个工具：`list_mcp_resources`、`list_mcp_resource_templates` 与 `read_mcp_resource`，各自要求必填的 `server` 参数（列表工具另有可选 `cursor`，读取工具另有必填 `uri`）。没有这类服务器时，这三个工具 schema 与服务器名段落都不存在。客户端连接、断开或重试时这些共享定义保持不变。存在可见提供方时，`mcp-resource-servers` 段落以 `MCP resource servers` 为标题，列出 `Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: <JSON array>.`。该段落以 `interpolate: false` 注册，因此服务器名中的花括号不会被当作提示词变量。

#### Token 影响

没有调用方可见的已配置服务器时，本包不增加工具或提示词 token。否则三个共享定义带来固定的 schema 开销，服务器名段落增加按序排列的可见名称 JSON 列表。资源列表与文档只在操作返回后增加内容。

#### KV Cache 影响

添加调用方可见的首个服务器或移除最后一个服务器，会改变后续工具 schema 前缀。可见名称变化时更新服务器名段落；替换同名提供方不会改变该文本。单纯的连接失败不会改变共享定义或名称。

### 资源结果

#### 模型看到什么

成功结果以 `MCP server: <server>` 开头，随后是换行与返回的 JSON。每个字符串值的 `blob` 都变为 `[binary resource: <length> base64 characters; available to programmatic callers]`。服务器提供的文本、元数据与续传游标仍然可见。

#### Token 影响

渲染后的结果向工具历史添加文本。二进制说明文字替代载荷的 base64 token 开销；本包不设置额外的文本大小限制。

#### KV Cache 影响

每个结果追加到历史中，不改写此前的结果。后续读取可以返回已变化的服务器内容并追加不同结果；本包不会刷新此前已记录的内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

资源访问由显式调用按需发起。

- **不支持 MCP Prompts**：本包只桥接 Resources；提示词模板与官方实现同样不支持。
- **不支持资源订阅与更新通知**：再次调用列表或读取工具以获取当前内容。
- **必须显式提供服务器名**：共享工具不聚合不同服务器；分页行为遵循 MCP SDK。
- **不具备 `resources` 能力的服务器仍出现在名称段落中**：SDK 返回空的列表，不受支持的读取会失败。
- **二进制资源不投影为原生图片或音频**：程序化调用方保留其规范 base64 值。
- **`tools.restrict()` 与作用域的关系**：注册过滤条件检查全局或祖先作用域提供的名称；调用方自身作用域中注册的资源工具不受 allow/deny 掩码过滤。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 作用域提供方集合与共享工具注册由同一个 owner 在同一个 effect 事务里维护，没有可供比对的独立运行时来源；提供方存活与工具出现/移除的配对关系由行为测试断言。
