---
description: "第四批上游能力移植方案：MCP 资源访问与服务器指令、客户端 keyed 标准钩子与资源注册表、已归档会话设置页与归档集合竞态修复、斜杠菜单共享排序器。"
kind: "design-draft"
---

# 第四批：客户端能力移植方案

本批次移植官方仓库中四项客户端能力。基线见[上游差异扫描分析](upstream-diff-analysis.zh.md)。所有官方提交 hash 均指官方仓库 `0a53fb55be..master` 区间。

## 1. 范围

| 项 | 官方证据 | 本地现状 | 改动量 |
|---|---|---|---|
| MCP 资源访问与服务器指令 | `3ba5b6eb04`、`e08468954a`、`834bd55a59` | `mcp-client` 只桥接 Tools，无资源能力 | 新增包约 790 行 + client 接线 |
| 客户端 keyed 标准钩子与资源注册表 | `packages/client/resources` | 渲染层已就绪，缺类型合成与绑定分支 | 类型约 60 行 + 新增包约 1200 行 |
| 已归档会话设置页 | `5f773a0ded`、`76941d0085` | 归档能力齐备但无恢复入口；归档集合安装无竞态守卫 | 新增包约 900 行 + 16 行守卫 |
| 斜杠菜单共享排序器 | `46d20f8bee` | `ui-commands` 有功能等价的内联实现，`ui-skill` 只用前缀匹配 | 新增 93 行 + 两处替换 |

## 2. 关键设计决策

### D1 斜杠菜单排序器是纯函数，且泛型约束接受本地字段名

`rankByName` 只依赖入参，不接触 `ctx`、不注册服务。放在 `packages/client/ui-primitives` 使 `ui-commands` 与 `ui-skill` 都能导入而不引入新的包依赖边。

算法为不区分大小写的有序子序列匹配，复杂度 O(name × query)：query 的每个字符必须按序出现在 key 中。排序键依次为前缀命中、对齐得分、源序。空查询直接返回输入数组本身。

**与官方 API 的分叉**：官方泛型约束是 `{ name: string; label?: string }`，`label` 来自 `5b1bb021cf` 对 `InputTriggerCandidate` 的改名。本地该接口仍用 `title`（`packages/client/ui-input-trigger/src/types.ts:50`）。本方案把约束写为 `{ name: string; title?: string }`，使本地调用方无需改名即可获得"标题参与搜索"的行为。

改名为 `label` 会波及 `ui-input-trigger`、`ui-commands`、`ui-skill`、`ui-directory-picker-browse`、`ui-reference` 与相关快照；同时接受两个同义字段会让类型契约含糊。改名留给后续独立的菜单重排批次。

**行为增强**：本地 `fuzzyScore` 只对 `name` 打分，`title` 完全不参与匹配。新排序器把 `title` 作为第二键，因此 `/` 菜单中输入本地化标题也能匹配到命令。这是用户可见的增强，需同步更新既有测试断言。

**必须删除本地内联实现**：保留两份会让 `jscpd` 重复检测报错，也会让两处语义在未来漂移。

### D2 归档集合的竞态守卫先于 UI 单独落地

`WorkspaceArchiveValue` 的 `archivedSessionIds` 有四个写入者：`archiveSession` 与 `unarchiveSession` 的一元回复、`replaceArchived` 的 stream 增量、以及 `replaceBaseline` 的完整基线。

本地 `packages/api/workspace-controller/src/client/model.ts` 的两个一元操作在收到成功回复后**无条件**安装结果（`:165-172`、`:178-184`）。当回复晚于更新的请求或晚于一个已推送的增量到达时，它会用陈旧集合覆盖新集合。

守卫方式是单调递增的 `archiveRequestSeq`：每个一元操作在发起前自增并记住自己的序号，回复到达时只有序号仍是当前值才安装结果；`replaceBaseline` 与 `replaceArchived` 也自增该序号，使任何更新的推送都作废在途的一元回复。

官方该提交的净改动只有 `model.ts` 的 16 行（另含页面收窄），**不依赖新页面**，因此可以独立测试与独立提交。

### D3 已归档会话页只注册一个 slot，不持有 store

页面注册 `settings.section`（`id: 'archived-sessions'`、`order: 25`、`label: () => t('nav')`），读 `useWorkspaces` 与 `useSessions` 两个全局标准 prop，唯一写入是注册期闭包注入的 `unarchive` 回调。

不新增 store：归档集合已在 `ui-workspace` 的模型里。这符合 `packages/client/AGENTS.md` 的"web 层是纯呈现"与"组件永不接触 ctx"约束。

`order: 25` 不与本地现有值冲突（现有 `general`/0、`models`/10、`plugins`/15、`prompt-commands`/16、`skills`/17、`agent-presets`/20、`mcp`/20）。

行派生把归档集合与已加载摘要合并，并对**没有摘要的成员直接丢弃**，因此归档集合中记录已删除会话时不产生行，也不产生无法完成的取消归档操作。三种空态分别对应"归档集合为空"、"归档成员均无可恢复会话"与"查询无匹配"。

**单语词典**：本地 `LOCALE_IDS` 为 `['zh']`，因此 `ctx.locale.register(NS, { zh })`。官方中文词典的 15 个键（含 `time.*` 相对时间键）可直接采用——本地 `ui-primitives` 的 `relativeTime` 返回的 `unit` 取值与官方逐字一致。

### D4 keyed 标准钩子只需补类型合成与绑定分支

本地渲染层的 keyed 标准源链路**已经完整**：`ui-slots/src/renderer.ts:65` 定义 `KeyedStandardSource`，`:78` 的 `StandardSourceBinding` 携带 `keyedHooks`，`:111-114` 的 `RootStandardSourceContribution` 接受 `keyedHooks`；`ui-renderer/src/client/registry.ts:275` 的 `provideRoot` 接收该贡献；`bindings.tsx:104` 的 `keyedObservableHook` 生成按 key 订阅的钩子；`scoped-slots.tsx:384-389` 的 `materializeStandardBinding` 已有 keyedHooks 分支。

缺口只有两处：`ui-slots/src/index.ts:447-448` 的 `InjectFace` 只有两个分支，没有 keyedHooks 的类型合成；`scoped-slots.tsx:116-130` 的 `bindInjectHooks` 只遍历 `hooks`。

改动是纯扩展：未声明 `keyedHooks` 的 inject 面落到原有分支，因此既有 slot 组件零改动。

### D5 资源注册表落地后暂无消费者

本地没有 `packages/api/workspace-files`、`packages/client/ui-sidebar-documentpreview` 与 `packages/client/ui-sidebar-right`，因此 `resources` 包落地后没有任何 provider 与消费者。

本批次仍交付它，理由是 keyed hooks 的类型合成有独立价值且风险低，而 `resources` 是后续侧栏批次的前置。该状态在包 README 的"已知限制与延期工作"中显式记录，避免读者误判它是死代码。

**资源记录不删除**：最后一个持有者释放后只把快照重置为空闲状态，不删除记录。理由是 `source(address)` 的引用必须跨 React 的"先渲染后订阅"窗口与 StrictMode 的重挂载保持稳定。代价是内存随读过的不同地址数增长。

**持有者计数合并订阅与 pin**：第一个持有者开启提供方的异步流，最后一个释放时中止流并重置快照。`pin(address, signal)` 不产生订阅，只在 signal 中止前让资源保持打开。

### D6 MCP 资源需要两项 system prompt 前置能力

`packages/core/system-prompt` 需要两个改动，两者都是本批次的硬前置。

**`PromptSection.interpolate?: boolean`**：段落默认参与 `{{variable}}` 插值。MCP 服务器指令是**外部字面文本**，其中可能包含花括号；若不关闭插值，插值引擎会把它们当作未知变量抛错。字段缺省为 `true` 以保持既有段落行为。该字段需同时加到 `PromptSection` 与 `AssembledSection`，并在 `renderPrompt` 中按 `interpolate === false` 分支直接取原文。

**`SECTION_ORDERS.MCP_SERVERS: 3100`**：本地现有取值在 `TOOL_REPORT: 2900` 之后直接跳到 `TOOLS_SDK: 5000`，3100 落在两者之间。

### D7 MCP 资源工具随提供方存活

`ctx.mcpResources` 用 `dsh-scope` 的 `ScopedLayers` 维护每个作用域的资源提供方集合。本地 `packages/core/scope` 已导出所需全部原语（`NamedEntries`、`ScopedLayers`、`createScope`、`scopeOf`、`ScopeKey`、`ScopeLayer`），无需新增依赖。

按作用域而非全局的理由：MCP 服务器按 profile 与 agent 作用域挂载，资源可见性必须与工具可见性一致。请求时用 `exec.agent` 合并作用域链查找提供方。

三个工具是**共享的**：它们不属于任何单个服务器，而是按服务器名参数分派。因此注册时机由作用域内的提供方数量决定——第一个提供方注册时注册全部三个工具，最后一个卸载时移除它们。这避免了"没有服务器时也暴露三个必然失败的工具"。

**二进制载荷不进模型上下文**：`read_mcp_resource` 的结果可能是二进制（MCP 协议用 base64 的 `blob` 字段承载）。渲染时把 `blob` 键的字符串值替换为说明文字，原始数据仍保留在工具结果 JSON 中。

**指令超限失败而非截断**：`maxInstructionBytes` 默认 32768。截断后的指令可能语义不完整，静默截断比失败更危险。

### D8 本地 OAuth 与白名单不受 MCP 资源影响

本地的 `McpAuthSink` 与 `allowedTools` 都作用于**服务器自报工具**：白名单在 `syncTools` 阶段按原始 wire 工具名剪枝，OAuth 在建立连接前解析凭据。

资源工具是**客户端自注册的共享工具**，不经 `syncTools`，因此不被白名单过滤；资源读取走已建立的连接代际，因此不涉及凭据解析。

`ConnectionHandle` 需要扩展为携带 `resources` 与 `instructions()`，但 `startConnection` 的既有五参数签名不变。

**本地 SDK 版本已具备资源 API**：本地 MCP SDK 为 `@modelcontextprotocol/sdk` 1.29.0，其 `Client` 已提供 `listResources`、`listResourceTemplates`、`readResource` 与 `getInstructions`。官方的 `@modelcontextprotocol/client@2.0.0` 迁移是另一件独立的事（涉及协议协商、transport 所有权与输出校验），不在本批次范围。

## 3. 被拒绝的方案

**把 `InputTriggerCandidate.title` 改名为 `label`**：不采用。会牵动 5 个包与大量快照，与本批次"提取共享排序器"的目标无关。

**只做归档集合竞态修复、不做设置页**：不采用。竞态修复解决的是"集合被陈旧回复覆盖"，而用户看不到归档会话的根因是没有入口；两者一起交付才能形成可验证的闭环，但实现顺序上先做守卫。

**为归档集合加分页或虚拟滚动**：不采用。官方按归档时间倒序全量渲染且页面带搜索框；本地会话规模不需要分页，引入它会增加状态与测试面。

**把 `ResourceProtocolMap` 放在 `resources` 包**：不采用。协议属主需要声明自己的成员，若合并点位于资源实现包，属主就必须依赖该实现包，形成反向依赖。

**在释放全部持有者时删除资源记录**：不采用。记录删除会让 `source(address)` 返回新引用，破坏渲染到订阅窗口与 StrictMode 重挂载期间的一致性。

**把三个资源工具挂在每个服务器实例下**：不采用。工具名会按服务器前缀分裂，模型需要在每个服务器上分别发现同名能力，且没有服务器时这些工具仍存在但必然失败。

**把 MCP 服务器指令并入既有的工具提示词段落**：不采用。指令属于服务器级元数据而非工具描述，混入会让它随工具集合变化而被重写，且无法在连接断开时独立撤回。

## 4. 影响面

- `packages/client/ui-primitives/src/rank-by-name.ts`：新增；`src/index.ts` 新增导出
- `packages/client/ui-commands/src/client/service.ts`：删除约 62 行内联实现，改调 `rankByName`
- `packages/client/ui-skill/src/client/index.ts`：候选源改用 `rankByName`，并补子 agent 会话守卫
- `packages/api/workspace-controller/src/client/model.ts`：+16 行序号守卫
- `packages/client/ui-settings-unarchive-sessions/`：新增包
- `packages/client/ui-settings-general/src/client/SettingsRoot.tsx`：`navIcon` 加一行分支与图标导入
- `packages/client/ui-slots/src/index.ts`：新增三个类型与 `ResourceProtocolMap`，`InjectFace` 改三分支
- `packages/client/ui-renderer/src/client/scoped-slots.tsx`：`bindInjectHooks` 增加 keyedHooks 循环
- `packages/client/resources/`：新增包
- `packages/core/system-prompt/src/index.ts`：`interpolate` 字段与 `MCP_SERVERS` 常量
- `packages/mcp/mcp-resources/`：新增包
- `packages/mcp/mcp-client/src/server-context.ts`：新增；`connection.ts` 与 `index.ts` 接线
- `packages/bundle/base`、`packages/bundle/sdk-minimal`、`packages/bundle/web-app`：挂载新包
- `tsconfig.base.json`、`tsconfig.client.json`、`tsconfig.host.json`、`apps/web/tsconfig.json`：登记新包
- `apps/web/tests/`：新增归档会话端到端用例

## 5. 验证方式

- 排序器：单测覆盖空查询返回输入本身、大小写不敏感、前缀优先于更强非前缀对齐、相邻与间隔取较大值、非子序列返回空、源序稳定、`title` 作为第二键
- 归档会话：单测覆盖行派生与倒序、无摘要成员被丢弃、三种空态、搜索过滤、取消归档调用；竞态用例构造晚到的陈旧回复与先到的 stream 增量
- keyed hooks：类型级与绑定级用例断言声明 `keyedHooks` 的面产出 `use<Name>`、未声明的面合成结果不变、按 key 选择器只在该 key 变化时重渲染
- 资源注册表：覆盖协议解析、重复注册被拒、四种 status、失败帧保留上一个值、持有者计数、`pin` 与 signal 中止、`source()` 引用稳定
- MCP 资源：覆盖无提供方时工具不存在、首个提供方使工具出现、最后一个卸载时移除、作用域可见性、缺参数在派发前失败、二进制以说明文字呈现、指令注入与断开撤回、超限失败、未挂载资源包时客户端仍工作、白名单不影响资源工具
- 快照：MCP 资源与系统提示词段落影响模型可见输出，需新增会话快照场景
