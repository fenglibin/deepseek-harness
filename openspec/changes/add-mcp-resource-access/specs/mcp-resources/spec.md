# mcp-resources 规范增量

## ADDED Requirements

### Requirement: system prompt 段落可以退出变量插值

`PromptSection` SHALL 支持可选的 `interpolate` 字段，缺省 SHALL 按 `true` 处理。当某段落的 `interpolate` 为 `false` 时，其文本 SHALL 作为字面量进入组装结果，SHALL NOT 参与 `{{variable}}` 替换。

`AssembledSection` SHALL 保留该字段，使 `renderPrompt` 能按它分支。

#### Scenario: 关闭插值的段落保留花括号字面量

- **WHEN** 一个段落以 `interpolate: false` 注册且其文本含 `{{name}}`
- **THEN** 组装结果 SHALL 原样包含 `{{name}}`
- **AND** SHALL NOT 抛出未知变量错误

#### Scenario: 省略插值字段的段落行为不变

- **WHEN** 一个段落未声明 `interpolate`
- **THEN** 其文本 SHALL 照常参与变量替换
- **AND** 其行为 SHALL 与本变更前一致

### Requirement: 段落位置包含 MCP 服务器区段

`SECTION_ORDERS` SHALL 包含 `MCP_SERVERS` 位置，取值 SHALL 落在工具类段落之后、SDK 段落之前。`getSectionOrder('MCP_SERVERS')` SHALL 返回该值。

#### Scenario: MCP 段落位置可解析

- **WHEN** 一个贡献方调用 `getSectionOrder('MCP_SERVERS')`
- **THEN** 它 SHALL 得到一个数值
- **AND** 该值 SHALL 小于 `TOOLS_SDK` 的位置

## ADDED Requirements

### Requirement: MCP 资源按作用域可访问

`ctx.mcpResources` SHALL 提供按作用域的资源提供方注册。每个已配置服务器的连接 SHALL 注册其资源访问，注册 SHALL 随该作用域释放而撤销。

同一作用域内同一服务器名 SHALL 只能注册一次；重复注册 SHALL 抛错。

#### Scenario: 注册服务器资源访问

- **WHEN** 一个 MCP 服务器连接成功并注册其资源访问
- **THEN** 该服务器名 SHALL 在调用方作用域内可解析
- **AND** 请求 SHALL 经该连接代际执行

#### Scenario: 同作用域重复注册被拒绝

- **WHEN** 同一作用域内两次注册同一个服务器名
- **THEN** 第二次注册 SHALL 抛出错误

#### Scenario: 不可用的服务器名在请求前失败

- **WHEN** 一个请求指定了当前 agent 作用域内不可用的服务器名
- **THEN** 该请求 SHALL 抛出说明服务器不可用的错误
- **AND** SHALL NOT 发起任何网络操作

### Requirement: 三个共享资源工具随提供方存活

系统 SHALL 提供 `list_mcp_resources`、`list_mcp_resource_templates` 与 `read_mcp_resource` 三个工具。它们 SHALL 在作用域内首个提供方注册时出现，并 SHALL 在最后一个提供方卸载时移除。

每个工具 SHALL 要求显式传入服务器名参数。

#### Scenario: 无提供方时工具不存在

- **WHEN** 一个作用域内没有任何资源提供方
- **THEN** 三个资源工具 SHALL NOT 出现在该作用域的工具注册表中

#### Scenario: 首个提供方使工具出现

- **WHEN** 一个作用域内注册了首个资源提供方
- **THEN** 三个资源工具 SHALL 出现在该作用域的工具注册表中

#### Scenario: 最后一个提供方卸载时工具移除

- **WHEN** 一个作用域内的最后一个资源提供方被卸载
- **THEN** 三个资源工具 SHALL 从该作用域的工具注册表中移除

#### Scenario: 缺少服务器参数在派发前失败

- **WHEN** 调用任一资源工具但未提供服务器名
- **THEN** 该调用 SHALL 在派发前失败

### Requirement: 资源读取按需执行且二进制不内联

三个工具 SHALL 在调用时才读取服务器内容。`read_mcp_resource` 的结果 SHALL 以可读文本呈现，其中的二进制载荷 SHALL 以说明文字替代，原始数据 SHALL 保留在结果 JSON 中。

结果文本 SHALL 标明来源服务器名。

#### Scenario: 调用时才读取

- **WHEN** 一个资源工具被调用
- **THEN** 系统 SHALL 才向该服务器发起读取
- **AND** SHALL NOT 在注册时预取资源内容

#### Scenario: 二进制载荷以说明文字呈现

- **WHEN** `read_mcp_resource` 的结果含 base64 编码的二进制字段
- **THEN** 模型可见文本 SHALL 包含说明该二进制载荷的替代文字
- **AND** 原始 base64 数据 SHALL 仍保留在结果 JSON 中

#### Scenario: 结果标明来源服务器

- **WHEN** 任一资源工具返回结果
- **THEN** 其文本 SHALL 包含来源服务器名

## ADDED Requirements

### Requirement: 服务器指令作为独立段落注入

每个已连接 MCP 服务器 SHALL 贡献一个以服务器名标识的 system prompt 段落，文本为其初始化时返回的 instructions。该段落 SHALL 以字面量方式注入，SHALL NOT 参与变量插值。

连接未建立、失败、断开或释放时，该段落的文本 SHALL 为空字符串。

#### Scenario: 连接成功后注入指令

- **WHEN** 一个 MCP 服务器连接成功且返回非空 instructions
- **THEN** 其指令文本 SHALL 作为独立段落进入系统提示词
- **AND** 其中的花括号 SHALL 保持字面量

#### Scenario: 未提供指令时不留下空段落

- **WHEN** 一个 MCP 服务器返回空 instructions
- **THEN** 该段落 SHALL NOT 出现在最终提示词中

#### Scenario: 断开后指令撤回

- **WHEN** 一个已注入指令的服务器断开连接
- **THEN** 其段落文本 SHALL 变为空字符串
- **AND** 该段落 SHALL NOT 出现在最终提示词中

#### Scenario: 指令超过上限时连接失败

- **WHEN** 服务器返回的 instructions 超过 `maxInstructionBytes`
- **THEN** 该次连接 SHALL 失败并说明原因
- **AND** SHALL NOT 注入截断后的指令

### Requirement: 资源能力以可选服务注入

`dsh-mcp-client` SHALL 经可选服务注入方式贡献资源访问与指令段落，SHALL NOT 静态要求 `mcpResources` 或 `systemPrompt` 服务存在。

#### Scenario: 未挂载资源包时客户端仍工作

- **WHEN** 一个组合挂载 `dsh-mcp-client` 但未挂载 `dsh-mcp-resources`
- **THEN** MCP 工具桥接 SHALL 照常工作
- **AND** 三个资源工具 SHALL 不存在

#### Scenario: 资源工具不受工具白名单影响

- **WHEN** 一个服务器配置了工具白名单且该服务器提供了资源
- **THEN** 白名单 SHALL 只过滤服务器自报的工具
- **AND** 三个共享资源工具 SHALL 不受白名单影响
