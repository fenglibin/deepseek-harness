---
description: "官方 DSH 与本地中文优先 fork 的全量差异扫描：官方 2717 个提交带来的新增与完善、可借鉴项及其优先级、以及本地独有能力与上游合并风险。"
kind: "design-draft"
---

# 官方 DSH 与本地 fork 的差异扫描分析

本文档是一次只读扫描的结论，用于决定后续把哪些官方能力纳入本地仓库。扫描基线：官方仓库 HEAD `0d1f50007f`（`0.1.6-alpha.1`），本地仓库 HEAD `d7c791feb6`（`0.1.2-alpha.2`，分支 `new-feature-20260905`），共同分叉点 `0a53fb55be`。

## 1. 规模基线

| 项 | 官方 | 本地 |
|---|---|---|
| 分叉后提交 | 2717 | 36（另有 78 个未提交改动文件） |
| 改动量 | 9457 文件 / +1,027,454 −129,792 | 5039 文件 / +69,759 −147,851 |
| 二级包 | 284 | 265 |
| 能力接缝（`ctx.*`） | 76 | 73 |

官方在分叉后推进了 163 个 `feat`、40 个 `perf`、122 个 `refactor`、689 个 `fix`。这不是增量演进，而是一次架构级推进。

**包结构差异。** 官方新增顶层组 `browser-use/`、`computer-use/`、`ptc-runtime/`、`ssh/`；把 `code-runtime/` 更名为 `ptc-runtime/`；退役 `e2b/` 与 `examples/`。本地自建了 14 个官方没有等价物的包：`delivery/`（含 `tool-delivery`）、`fs/file-changes`、`core/lightweight-model`、`llm/image-understanding`、`llm/llm-failover`、`llm/llm-round-robin`、`mcp/mcp-manager`、`host/skill-manager`、`context/response-language`、`interaction/command-prompt-config`，以及 `client/ui-{delivery,session-changes,settings-commands,settings-mcp,settings-skills}`。

**能力接缝差异。** 官方独有 9 个：`ctx.browserUse`、`ctx.computerUse`、`ctx.fileUploads`、`ctx.mcpResources`、`ctx.ptcRuntime`、`ctx.sessionFeedback`、`ctx.ssh`、`ctx.terminalController`、`ctx.workspaceFiles`。本地独有 5 个：`ctx.codeRuntime`、`ctx.delivery`、`ctx.imageUnderstanding`、`ctx.lightweightModel`、`ctx.skillRoots`。

## 2. 官方新增与完善的功能主线

### 2.1 执行与访问进入可强制的边界

这是官方本轮最重要的方向，包含四条独立但同向的改动。

**PTC 运行时从 worker 隔离改为 OS 沙箱进程。** 本地 `packages/code-runtime/code-runtime-worker-thread` 自述"信任立场与 bash 等价"。官方决策记录 `.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md` 指出：worker 隔离不应用 Session 的 OS 沙箱策略，模型代码可直接 `import fs` 或 `child_process` 绕过工具策略路径，且终止 worker 不能证明其子进程已停止。官方改为每个程序一个全新 Node 进程，经与 Bash 同一个 `ctx.sandbox` 约束，生命周期交给 `ctx.subprocess`；新增 8 类正交失败分类与 `resolve`/`run` 拆分。相关提交 `f95f7ec8dc`、`75ed8da3e0`、`a248cc4e64`、`7c9bb5914c`。

**新增 SSH 远程执行并退役 E2B。** `packages/ssh/` 共 63 文件 / +7105 行、20 个提交，实现既有的 `ctx.fs`、`ctx.subprocess`、`ctx.sandbox` API 而不引入专用工具；安全细节包括逐流 256 位 TLS-PSK 认证与辅助程序 SHA-256 校验。同期 `c49db8bc8c refactor(e2b): retire remote execution providers` 删除 `packages/e2b/`（37 文件 / −8246），理由是 E2B SDK 无法承载 PTC 所需的额外描述符。本地仍保留 `packages/e2b/`。

**新增 browser-use 与 computer-use 两个 seam。** 两者都极小（各约 448 行），`register()` 只预留唯一提供方槽位，不含通用操作方法。实验性提供方位于 `experimental/`，包括 Playwright MCP、Chrome DevTools MCP、Stagehand 原生与 Cua Driver。本地零基础。

**新增 Auto review 权限分级。** `packages/experimental/auto-review`（9 文件 / +3238）在每次工具调用前经一次 LLM reviewer 审查，按动作实际效果分 `low`/`medium`/`high`，fail-closed 且显式 opt-in。前置依赖是官方在 `packages/interaction/permission-presets/src/index.ts` 新增的 `AUTO_PRESET` 与 `autoAdmit` 注册点，本地没有。

### 2.2 会话格式版本化与内存根因治理

官方新增 5 个包共 13,655 行：`session-format`、`session-format-catalog`、`session-format-v0-to-v1`、`session-format-v1-to-v2`、`session-format-v2-to-v3`。

驱动它的是实测故障：一份 116 MB 的真实 Session 在返回 handle 前耗尽 16 GB Node 进程。归因是 317,540 个 Zstandard frame 各自独立异步解压后再统一拼接，且 914 万个 v0/v1 逻辑事件与 72,784 个 current event 同时存活。解决方案是有状态同步 Stage API，取代"数组到数组"的整件迁移。

官方 Note 记录的收益：

| 场景 | 整件迁移 | 流式 Stage |
|---|---|---|
| 物理解码 | 7.527s / 7219MB | 1.467s / 908MB |
| 首次冷打开 | >72.8s（OOM） | 6.241s / 2107MB |
| 常驻堆（读当前格式） | 2.016GB | 476MB |

`SESSION_FORMAT_VERSION` 本地为 `0`，官方为 `3`（`packages/core/session/src/types.ts`）。本地无任何迁移包，`coordinator.ts` 对旧版本直接拒绝。

### 2.3 系统提示词提升为 surface node

本地 `EpochHeader` 仍有 `system?: string` 字段（`packages/core/session/src/types.ts:185`），官方已移除。官方决策记录 `.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.zh.md` 的理由是提示词"拥有两个归属"：既在仅记日志的 header 快照里，又必须被每个序列化器前置为协议消息 0。官方改为 `system/message` surface 事件，并新增头部保护不变量 `assertSystemHeadRewrite`。

附带缓存收益：具备 `systemPromptUpdate: 'in-history'` 能力的路由可把非空提示词变更追加到已缓存历史之后，前缀缓存得以复用。

### 2.4 性能优化

官方 40 个 `perf` 提交，关键项：

- `session-projection` 双槽身份闸门（`6f0daff1dd`）：`views: [unknown, unknown]` 加两层 `Object.is`，无 listener 时根本不调用 `view`。注意同日的 `12bef3b577`（WeakMap 记忆化）已被推翻
- `agent-loop` 消息冻结复用（`73edce1ae7`）：`WeakSet<Message>` 按对象身份复用冻结证明，请求历史中位数 246.131ms → 67.293ms，核心逻辑净增 7 行
- assistant stream 嵌入（`165cc31eb8`）：first-open projection 28.0 → 5.9 ms，峰值 RSS 137.2 → 94.6 MB
- `typert` schema 惰性物化（`e459e32637`）：启动期从构造全部 zod schema 改为首次使用时物化
- 延迟原生依赖（`232ab768a9`，45 文件）与 `lazy-require` 原语（`eb8cc594b3`）
- 终端 scrollback 增量保留（`cea837e065`）：4 MiB 场景 4159ms → 8.7ms
- 新增 `benchmarks/`（34 文件 / 2758 行）与独立 CI lane

### 2.5 客户端全局面板系统

`packages/client/` 区间变更 1216 文件 / +67,681 −21,098，包数 44 → 53。新增 9 个包：`ui-dockkit`(+8484)、`ui-sidebar-documentpreview`(+8010)、`ui-sidebar-right`(+6395)、`ui-sidebar-files`、`ui-sidebar-terminal`、`file-upload`、`resources`、`ui-open-in-app`、`ui-settings-unarchive-sessions`。

同期三处详情面板下线（`ui-chat/DetailsPanel`、`ui-tool/ToolDetails` 与两个 slot），改由 `ui-slots` 新增的 `KeyedSnapshotSelectorHook`/`PropsKeyedHooks` 支撑按 key 细粒度订阅。

### 2.6 桌面端

`apps/desktop`（51 提交 / +11159）与 `apps/desktop-host`（14 提交 / +885）构成 Electron 应用。核心决策是构建期物化运行时：`prepare-dsh.ts` 在构建时安装生产依赖并生成带 sha256 的 `desktop-runtime.json`，首次启动不装核心依赖。

一个需要注意的事实：官方桌面端不在 CI 中（`.github/` 无 desktop 引用，覆盖率 `include` 不含 `apps/`），README 自己承认需要生产签名环境验收。

### 2.7 MCP 演进

官方把 SDK 从 `@modelcontextprotocol/sdk@^1.12.0` 迁到 `@modelcontextprotocol/client@2.0.0`，新增 `packages/mcp/mcp-resources/`（三个资源工具）与 server instructions 注入（每个服务器一个独立 system prompt section，`interpolate: false`）。

## 3. 可借鉴项

### 3.1 高优先级

| 项 | 官方证据 | 成本 | 理由 |
|---|---|---|---|
| 移除 `str_replace_editor` 默认启用 | `36a4665144`、`965adbb5cf`、`63795eaa5c` | 极低 | 本地 `packages/bundle/base/cordis.patch.yml:493` 仍启用，与 `read`/`write`/`edit` 接口重叠 |
| 默认开启 `web_fetch` | `0a0f9e59ff`、`cf7b0bd5a4`、`ca723d9273` | 极低 | 本地同文件 `:534` 仍是 `fetch: false`，模型默认看不到联网读 |
| `session-projection` 双槽身份闸门 | `6f0daff1dd` | 低 | 本地该文件与分叉点逐字节相同，移植面干净 |
| `agent-loop` 冻结复用 | `73edce1ae7` | 低 | 实测 −72.9%，前提已验证成立 |
| `typert` schema 惰性物化 | `e459e32637` | 中 | 本地 typert 源文件与分叉点一致，命中本地性能目标 |
| `experimental-package-policy.ts` | `6e30e1a300` | 低 | 16 行单一真相源支撑整个发布策略 |
| `verify-no-bare-dispatcher` | `545e2ad914`、`4623c68e70` | 低 | 显式 dispatcher 会覆盖全局代理，对本地大量走网络的插件尤其相关 |
| `coverage-canonical-locations` + `test-proxy-environment` | — | 低 | 修幽灵未覆盖语句与代理环境污染 |
| `lazy-require` + 延迟原生依赖 | `eb8cc594b3`、`232ab768a9` | 中 | 本地 `attachment-local` 三处 `sharp` 是静态导入，启动路径真实加载原生模块 |
| MCP resources + server instructions | `3ba5b6eb04`、`e08468954a` | 中 | 本地完全不支持 MCP resources，与本地 OAuth/白名单零冲突 |
| `resources` 客户端包 | 1280 行 | 中 | 本地 `provideRoot`、`KeyedStandardSource`、`keyedObservableHook` 已存在，缺口约 80 行 |
| `ui-settings-unarchive-sessions` | 906 行 | 中 | 本地 `archivedSessionIds`、`unarchiveSession`、`settings.section` 已就位 |
| `ui-primitives` 的 `rankByName` | 93 行纯函数 | 低 | 零依赖可直接照搬 |

### 3.2 中优先级

| 项 | 说明 |
|---|---|
| invariant 伴生件精简 | 本地 267 个 `src/invariant.ts` 中 226 个是空壳，官方仅剩 39 个且无空壳。这是规则级分歧：本地 `packages/AGENTS.md:19` 要求每个包都拥有，官方已改为仅在观测发散时发布 |
| MCP SDK v2 迁移 | 本地 OAuth 依赖的 `authorization`/`credentials` 接缝在官方 master 上 diff 为 0 行，且本地 OAuth 注入点是 `transport.ts` 的 `requestInit.headers`，与 SDK 版本无关。但本地 `startConnection` 多两个参数，直接覆盖会编译失败 |
| `autoAdmit` 注册点 | auto-review 的前置依赖，本身是干净的可扩展点 |
| `--from-default-profile` + `watchConfig()` | 本地有 `PROFILE_TEMPLATES` 常量但无 CLI 入口 |
| 会话格式版本化 | 战略级，需 13,655 行并改变仓库核心立场。但本地 0 个 `.vN` 快照意味着每次格式演进都要重写全部 fixture |
| 系统提示词 surface node | 必须先于格式 v3 迁移 |
| `remote-mock` | 决定整机客户端测试能否脱离业务 Host |
| `file-upload` 最小闭环 | 本地附件只有图片，是真实缺口 |

### 3.3 低优先级与不建议

- `apps/desktop`：成本极高且官方自己不在 CI 中运行，本地无桌面发布需求
- `weighted-approval`：组织治理而非工程质量，官方自己随后删除了配套的自动审阅路由（−1856 行）
- `ui-sidebar-terminal`：依赖链最长，且本地提交 `5611dcfe6b` 已因沙箱限制移除 PTY 测试
- `ui-sidebar-documentpreview`：8010 行并引入 `pdfjs-dist` 精确版本与构建期资源内联
- `ui-chat`/`ui-conversation` 整体重构：本地已分别改动 +2424/−451 与 +2049/−820，集中在官方同期也在改的文件，rebase 不可行

## 4. 本地独有能力

以下能力在官方仓库没有等价物，升级时不应被覆盖：

| 能力 | 规模 | 官方情况 |
|---|---|---|
| MCP OAuth 授权（PKCE S256、grant 存 credentials seam、30 秒提前刷新、401 触发重发） | 839 行 | `packages/mcp/` 下无 OAuth，只有静态 header 认证 |
| MCP 工具白名单 `allowedTools` | — | 无等价物；官方 `ctx.tools.restrict` 是运行时、按 agent 作用域、注册后掩码，本地是配置期、按服务器、发现阶段剪枝 |
| `mcp-manager` + `ui-settings-mcp` | — | 无；官方 MCP 配置走通用 settings namespace |
| `host/skill-manager` + `ui-settings-skills` | — | 无 |
| `context/response-language` | — | 无 |
| `core/lightweight-model` | — | 无 |
| `fs/file-changes` | 545 行 | 无 |
| `delivery/` | — | 无；官方 `ui-deliverables` 是"文件引用与原生打开"，语义不同 |
| `llm/{image-understanding,llm-failover,llm-round-robin}` | — | 无 |
| `heap-watch.ts` 与 Agent 保留上限 | 153 行 | 无生产级堆水位机制 |

因此升级路径是"官方新版打底 + 重新应用本地扩展"，而非二选一。

## 5. 风险

### 5.1 上游合并的障碍主要在文档层

实测集合运算（本地删除 ∩ 官方修改）得到 1496 个 `delete/modify` 冲突：英文 `.md` 939 个、`.agents/notes/` 746 个、`packages/` 589 个、`.i18n.yaml` 537 个、`docs/` 137 个，而真实代码冲突只有 11 个 `.ts` 文件。

本地删除了 1273 个英文 `.md` 与 1264 个 `.i18n.yaml`，官方则以 1550 个 `.i18n.yaml` 构成完整的双语配对门禁。两处需要先修的不一致：

1. 本地 `.git/config` 仍注册 `merge.dsh-translation-pairing.driver`，但该脚本已不存在；一旦合并带回 `.gitattributes` 的 `*.i18n.yaml merge=` 行，git 会调用不存在的脚本
2. `website/docs.ts` 仍保留 `DocsLocale = 'root' | 'en'` 与 `pairedPages()` 的完整骨架，只有数据收窄

### 5.2 必须先决策的结构性问题

1. **E2B 去留**：官方删 E2B 换 SSH，本地保留 E2B。直接合并会删掉本地远程执行能力
2. **PTC 信任立场**：worker 隔离与 OS 沙箱之间是安全边界问题，不是性能问题
3. **会话格式断裂**：本地 `SESSION_FORMAT_VERSION = 0` 且无迁移包，官方已是 3，两边日志互不可读

### 5.3 容易误导的判断

- 本地 `build.sh` 不是自创优化：`scripts/client-build-environment.ts` 在分叉点就已存在，现在的 `build.sh` 只是 `pnpm run build` 的包装
- 官方 `profile-resolution/`（1178 行）对本地收益接近零：它服务于 pkg 可执行文件与 Electron 载体，普通 Node 调用方仍走 `link` 模式
- 不应盲目跟随官方删除 invariant：本地 `packages/AGENTS.md:19` 的规则不同，需先改规则

## 6. 落地批次

**第一批（快速收益）**：移除 `str_replace_editor` 默认启用、默认开启 `web_fetch`、`verify-no-bare-dispatcher`、`coverage-canonical-locations` 与 `test-proxy-environment`、`experimental-package-policy.ts`。

**第二批（运行时性能）**：`session-projection` 双槽身份闸门、`agent-loop` 冻结复用、`typert` schema 惰性物化并清理误跟踪产物。

**第三批（启动性能）**：`lazy-require` 原包与延迟原生依赖。

**第四批（客户端能力）**：MCP resources 与 server instructions、`resources` 客户端包与 keyed hook 类型合成、`ui-settings-unarchive-sessions`、`rankByName`。

后续批次（E2B 去留、PTC 执行后端、会话格式版本化）需先完成决策再规划。
