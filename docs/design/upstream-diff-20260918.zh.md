---
description: "官方 DSH 0.1.6-alpha.1 到 0.1.6-alpha.2 的增量差异，以及本地已完成第一批到第四批后的剩余可借鉴项与优先级。"
kind: "design-draft"
---

# 上游增量差异扫描（0.1.6-alpha.2）

本文档是第二次只读扫描的结论，用于决定第一批到第四批之后还应纳入哪些官方能力。基线：官方新快照 HEAD `ddefc45fbc`（`0.1.6-alpha.2`），官方旧快照 HEAD `0d1f50007f`（`0.1.6-alpha.1`），本地 HEAD `505f71af95`（分支 `new-feature-20260905`），共同分叉点 `0a53fb55be`。

第一次扫描的范围、方法与全量清单见[上游差异扫描分析](upstream-diff-analysis.zh.md)，四批落地方案见[第一批](upstream-batch1-quick-wins.zh.md)、[第二批](upstream-batch2-runtime-performance.zh.md)、[第三批](upstream-batch3-startup-performance.zh.md)、[第四批](upstream-batch4-client-capabilities.zh.md)。双语差异不在本次范围内，本地只维护中文文档。

## 1. 基线

| 项 | 官方 0918 | 官方 0915 | 本地 |
|---|---|---|---|
| HEAD | `ddefc45fbc` | `0d1f50007f` | `505f71af95` |
| 相对分叉点提交 | 3599 | 2717 | 72 |
| 二级包 | 291 | 284 | 276 |

官方在两个快照之间的增量是 882 个提交、2548 个文件、+100218 −23242，其中 98 个 `feat`、68 个 `refactor`、4 个 `perf`、207 个 `fix`。

新增 8 个包，移除 1 个：

| 包 | src 规模 | 职责 |
|---|---|---|
| `boot/plugin-manager` | 1327 行 | 当前 profile 的插件与组合包管理 |
| `boot/hmr` | 723 行 | 模块与配置热重载协调 |
| `client/ui-plugin-manager` | 2416 行 | 侧栏插件管理页 |
| `client/ui-sidebar-browser` | 834 行 | 右栏沙箱浏览器标签 |
| `deliverables/workspace-changes` | 1302 行 | 轮次改动文件，从 git 工作树快照记录 |
| `document/office-to-pdf` | 655 行 | Office 转 PDF 的共享转换与有界队列 |
| `skill/skill-office` | 70 行 | 随附的 Word、PowerPoint、Excel 工作流 |
| `deliverables/tool-present` | — | 从 `fs/tool-present` 迁入 |

**读提交列表会误导。** `git log 0d1f50007f..ddefc45fbc` 中的 `e0841bec01`（拆分管理器模块）与 `7af9c25737`（把 patch 文件解析折叠进 `app-boot`）都是 `ddefc45fbc` 的祖先，但它们的产物已被 09-15 的合并丢弃：最终树里没有 `packages/boot/plugin-manager/src/manager.ts`、`installer.ts`，也没有 `packages/boot/app-boot/src/patch-file.ts`。增量移植必须以实际树为准。同理，`packages/host/plugin-manager` 曾存在并被删除，只有 `packages/boot/plugin-manager` 存活。

## 2. 官方增量主线

### 2.1 插件管理器体系

四条并行分支在 09-15 到 09-16 密集合入：`#4182`、`#4238`、`#3596`、`#4324`。最终形态是三个包：服务层 `packages/boot/plugin-manager`（`@deepseek-ai/dsh-plugin-manager`）、重载协调 `packages/boot/hmr`、客户端页 `packages/client/ui-plugin-manager`。

服务是 `TypertRemoteService`，`static inject = ['loader', 'profileContext']`，八个 `@Remote` 方法（`listPlugins`、`listBundles`、`inspect`、`setPluginEnabled`、`setBundleEnabled`、`installBundle`、`cancelInstall`、`removeBundle`）与三个事件（`plugin-manager/changed`、`install-log`、`install-state`）。

**持久化写回。** `src/patch.ts` 的 `writePluginEnabled` 用注释保留的 YAML 文档改写 `cordis.patch.yml` 中最后一条匹配覆盖项的 `disabled`，没有匹配项时追加。匹配依据是条目 id 加上模块名断言。

**安装事务的安全工程**（`src/index.ts`）：所有写操作经唯一私有 `change()`，其中跨进程 `withFileLock` 加前后磁盘状态比较。安装前快照 `package.json` 与 `pnpm-lock.yaml`，失败或被取消即恢复；**刻意不恢复 `pnpm-workspace.yaml`**，因为 pnpm 在那里记录待审批的构建脚本名，恢复它会让用户无从批准。`cancelInstall` 返回三态（`cancelled`/`too-late`/`not-running`），理由是被中断的 RPC 说不清 pnpm 是否已停。卸载先从 `dsh.profile.bundles` 取消选入、等待旧 fiber 卸载，才执行 `pnpm remove`。构建脚本授权按准确包名持久化到 `allowBuilds`，并拒绝 YAML 锚点与别名。

**可选组合包机制**：随发行版交付、默认关闭、选中前永不可卸载的实验层。声明分两处——`apps/cli` 的 `package.json` 中 `dsh.optionalBundles` 列出安装随附的包，`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES` 常量是运行时可见的那一份（当前为两个 Agent Teams profile）。配合 `verify-default-product-isolation.ts` 保证它们不进入默认产品。Auto review 经 `8059d76ea3` 以同样方式交付。这是比直接改默认值更干净的实验能力交付模式。

### 2.2 产出物与变更记录

`packages/deliverables/workspace-changes` 汇总每个顶层轮次改动的文件与行数，并提供该轮首尾的内容对比。两条捕获路径：

- **git 工作树快照**：`turn/start` 时以仓库 index 为种子，在私有 index 上 `add --all --ignore-errors` 与 `write-tree` 得到 tree id，轮末再取一次，两树用 `diff-tree -r -M --numstat` 比较。命令通过 `GIT_OBJECT_DIRECTORY` 把新对象写进 Session 自己的临时目录，`GIT_ALTERNATE_OBJECT_DIRECTORIES` 以只读方式挂接仓库对象库，因此仓库的 index、objects、refs 与工作树都不被修改，用户此前未提交的改动属于基线。
- **整文件副本**：在 `write`、`edit` 或有修改作用的 `str_replace_editor` 运行前把该路径复制到 Session 临时目录，轮末再复制一次，按字节 SHA-1 内容寻址去重。这条不依赖 git，覆盖被忽略的文件、仓库外文件与无 git 场景。

`tools/pre-execute` 等待该队列，因此没有修改能先于其基线发生。Session 日志只收一条仅带轮号的 `workspace/changes` 事件；摘要、快照树与副本只活在 Host 内存与 Session 临时目录，`session/disposed` 时删除。官方决策记录 `.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.zh.md` 陈述的取舍是"卡片的寿命等于内容的寿命"。

**该包没有撤销能力**，全包检索 `revert`、`undo`、`rollback` 无命中。

### 2.3 其余主线

**Sidebar Browser** 用 iframe 实现，拒绝 Host 代理（官方理由：兼容代理必须重写 URL、CSP、Cookie、module、stream、form 与 download，同时把 Host 变成通用出站请求器）。核心设计是诚实的能力声明：跨域后读不到 URL 时导航状态为 `unknown`，`canGoBack` 以 `status !== 'unknown'` 为前提，不假装可用。只放行 `http:` 与 `https:`，拒绝 `file:`、`data:`、`blob:`、`javascript:`、内嵌凭据与 DSH 自身 origin。

**子代理限额。** `packages/subagent/subagent` 新增 `maxActiveSubagents`（默认 8），每个存活父代理一个 `ActivationPool`，超限抛 `ACTIVATION_LIMIT_REACHED` 且不排队（避免父等子死锁）。委派深度从工具侧的静态默认改为由 `ctx.subagents.resolveMaxDepth()` 读取设置，调低上限不驱逐驻留子代理。开箱的委派深度默认值是 1，即只允许直接子代理。

**Office 转换解耦。** `packages/document/office-to-pdf` 提供 `ctx.officeToPdf`，有界队列（`maxConcurrentConversions` 2、`timeoutMs` 60000、`maxInputBytes` 50MiB、`maxOutputBytes` 100MiB），按 generation 加扩展名加源字节 SHA-256 缓存。引擎策略是声明了原生引擎的目标用原生、其余用 Node WASM、**声明了原生但缺失时拒绝而非静默降级**。

**计划与交付物槽位。** `577e4a036d` 把 `conversation.chat.turnTail` 从 `chain` 改为 `list`，理由是一个回合内可能同时出现计划与文件产物，可追加列表让两个插件各自贡献内容而无需彼此了解。计划正文从既有会话日志的 `tool/call` 参数反解，不新增事件也不写文件。

**其余**：工作区树形分组成为显式选项（默认仍是同级分组）；模型输入控件统一（继承回退链为已声明 → 已安装目录 → 提供方默认 → `['text']`）；移除 V4 Flash 与 V4 Flash Vision Exp 的目录默认；已知站点链接标记（`SiteGlyph.tsx`，40 个主机后缀到 34 个标记）；菜单键盘模型修复；客户端 bundle 按需 chunk。

## 3. 本地现状核查

第一批到第四批已落地，逐项验证：

| 批 | 项 | 本地证据 |
|---|---|---|
| 一 | 移除 `str_replace_editor` 默认启用 | `packages/bundle/base/cordis.patch.yml` 已无 `tool-str-replace-editor` 行 |
| 一 | 默认开启 `web_fetch` | 同文件 `tool-web` 的 `fetch: true` |
| 一 | 三项门禁与脚本 | `scripts/verify-no-bare-dispatcher.ts`、`scripts/experimental-package-policy.ts`、`scripts/coverage-canonical-locations.ts` 均存在 |
| 二 | 会话投影双槽身份闸门 | `5fdbc42fce` |
| 二 | agent-loop 冻结复用 | `65f05222fa` |
| 二 | typert schema 惰性物化 | `f3e7a491b0` |
| 三 | `lazy-require` 与延迟原生依赖 | `38f791b8c7`、`207da07632` |
| 四 | MCP 资源与服务器指令、`resources` 包与 keyed hook、`ui-settings-unarchive-sessions`、`rankByName`、`http-proxy` | `ea07c9a52b`、`27125ee937`、`3528c3a166`、`c920bf371b` |

第五批与前次"建议搁置"项的状态：

| 项 | 本地现状 |
|---|---|
| PTC 沙箱迁移 | 仍为 `packages/code-runtime`，未改名也未换执行后端 |
| SSH 远程执行 | 无 `packages/ssh` |
| E2B 去留 | 仍保留 `packages/e2b`（`e2b`、`fs-e2b`、`subprocess-e2b`） |
| 会话格式版本化 | `SESSION_FORMAT_VERSION = 0`，无 `session-format*` 包 |
| 系统提示词 surface node | `EpochHeader.system` 仍在（`packages/core/session/src/types.ts`） |
| invariant 伴生入口 | 276 个，其中 235 个为空壳 |
| `turnTail` 槽位 | 仍为 `kind: 'chain'`（`packages/client/ui-chat/src/client/contract/slots.ts`） |
| 委托深度默认 | `maxDepth` 仍是静态 `default(3)`（`packages/subagent/tool-subagent/src/index.ts`） |
| `maxActiveSubagents` | 不存在 |
| 插件持久启停与包安装 | `host/plugin-inventory` 的 `setEnabled` 只改内存 Loader 条目，重启即回退；无执行 `pnpm add` 或 `pnpm remove` 的路径 |

## 4. 建议落地的项

### 4.1 git 快照接入本地变更体系

本地变更能力已相当完整——`fs/file-changes`（551 行）、`fs/session-file-revisions`（1753 行）、`api/session-file-revisions`（625 行）、`client/ui-session-changes`（2010 行）——与官方方案各有对方没有的能力：

| 维度 | 官方 `workspace-changes` | 本地 `session-file-revisions` |
|---|---|---|
| 捕获源 | git 快照加整文件副本 | 仅工具结果自带的 `before`/`after` |
| shell 与 bash 改动 | 捕获 | **不捕获**，见 `packages/fs/session-file-revisions/README.zh.md` 的已知限制 |
| 撤销 | 无 | 反向 patch、逐 hunk、冲突显式报告 |
| 持久化 | 重启即失 | 跨重启 |
| 删除检测与恢复 | 隐式 | 显式，并从 git 取回 |
| 子代理归属 | 不记录 | 沿 `parentSession` 计入根会话 |
| 变更判定归属 | 两处重复实现 | 单点归属在 `fs/file-changes/mutation.ts` |

**建议只取 git 快照捕获这一段**，接在本地 `fs/session-file-revisions` 上补 shell 改动，而不是引入官方整套 Host 内存方案。两者对"记录活多久"的取舍相反：本地认为记录应持久，官方认为卡片寿命等于内容寿命。

官方的实现要点可直接照搬：`GIT_OBJECT_DIRECTORY` 指向 Session 临时目录、`GIT_ALTERNATE_OBJECT_DIRECTORIES` 只读挂接仓库对象库，因此用户仓库的 index、objects、refs 完全不动。依赖面本地全部具备：`ctx.subprocess`、`agent/turn-stopping`、`tools/pre-execute`、`diff@^9`。官方记录的性能是一万个文件的仓库一次快照约 60 ms、比较约 10 ms。

### 4.2 `turnTail` 从链改为列表

官方把 `conversation.chat.turnTail` 从 `chain` 改为 `list`（`577e4a036d`），本地仍是 `chain`（`packages/client/ui-chat/src/client/contract/slots.ts:196`）。

链的语义是"第一个接受的 selector 渲染，全部拒绝则空"，因此同类型贡献方会互相遮蔽而非并存。本地当前只有 `ui-deliverables` 一个 `turnTail` 贡献方（其 `selectProducedFiles` 决定是否渲染），`ui-session-changes` 走的是 `conversation.input.dock`，所以今天尚未出现冲突。改为列表后，计划卡片、变更卡片与产物行才能在同一个回合尾各占一行。

改造面比"改一个字段"更广，需要同步处理 `renderSlotChain` 调用点（`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:45`）、节点渲染注册表（`register-node-renderers.ts:51`）、`cordis-client-runner` 的 slot 目录及其示例，以及 `ui-deliverables` 的既有断言（其测试夹具显式声明 `kind: 'chain'`）。

### 4.3 插件管理的持久启停与包安装

本地管理能力止步于配置文件读写与运行时易失启停：`skill-manager` 写技能目录、`mcp-manager` 读写 `mcp.json`、`plugin-inventory` 的 `setEnabled` 不落盘、两个 `ui-settings-*` 是配置与展示层。

官方这套提供三样本地完全缺失的能力：**持久启停**（`writePluginEnabled` 写回 `cordis.patch.yml`）、**包安装与卸载**（本地没有执行 `pnpm add` 或 `pnpm remove` 的代码路径；`execa` 只出现在测试支撑包 `test-support/loader-smoke` 里用于启动被测进程）、**安装事务的安全工程**（单次变更入口、跨进程写锁、manifest 快照恢复、可取消、构建脚本逐项审批、失败分类）。

命名空间无冲突：本地检索 `plugin_manager`、`plugin-manager/*`、`ctx.profileContext`、`plugins.item` 全部零命中。

可行的落地顺序是：先移植 `boot/hmr` 与 `profileContext` 数据面（本地 `app-boot` 只有三个文件，官方已拆成 `profile-context.ts`、`profile-plugins.ts`、`profile-resolution/`），再只移植 `boot/plugin-manager` 的服务层，**不动 `packages/client/*`**。客户端的 slot 重命名与侧栏页应暂缓，因为它们与本地已改造的 settings 结构正面冲突，且属于产品形态决策。

**不要跟 `host/plugin-manager` 这条线**，官方自己删除了它。

### 4.4 子代理限额

官方引入了两项本地没有的保护。`maxActiveSubagents`（默认 8）在每个存活父代理上限制同时活跃的可续接子代理，超限时不排队而是带可操作诊断失败。委派深度从静态默认改为由设置驱动，**开箱默认值是 1**，即只允许直接子代理，而本地仍是 3。两项都能降低失控风险且移植成本低。

### 4.5 其余

| 项 | 说明 |
|---|---|
| 计划卡片 | 计划正文从既有日志的 `tool/call` 参数反解，不新增事件与文件；复用同一 `turnTail` 列表 |
| 轮次级 diff 视图 | 每轮一张卡加该轮前后对比，与本地会话累积对比互补 |
| 可选组合包机制 | 实验能力随发行版交付但默认关闭、选中前不可卸载，配合同名门禁保证不进入默认产品 |
| 已知站点链接标记 | 纯增量、低风险 |
| 菜单键盘模型 | 修复箭头导航绑在自动聚焦上导致不自动聚焦的菜单完全无键走 |
| bundle 按需 chunk | 与本地既有性能方向一致 |

**不建议**：Sidebar Browser 与 `ui-sidebar-terminal`（依赖本地不存在的整套右栏基础设施，且本地提交 `5611dcfe6b` 已因沙箱限制移除 PTY 测试）、component factories 与 ownership primitives（架构级，本地尚无对应消费者）、桌面端相关（官方自己不在 CI 中运行）。

## 5. 第五批与搁置项的重新评估

| 项 | 前次判断 | 本次更新 |
|---|---|---|
| PTC 沙箱迁移 | 高优先，安全缺陷 | 维持。0918 仅两个 PTC 修复提交，机制稳定；本地仍是"信任立场与 bash 等价"的 worker 隔离 |
| E2B 与 SSH | 需先决策 | 改为搁置。0918 的 SSH 只有一处相关改动，方向未变；本地是内网中文环境，远端执行需求弱，保留 E2B 即可 |
| 会话格式版本化 | 战略级 | 维持搁置。0918 未推进格式版本，仍是 3。除非决定整体 rebase，否则不动 |
| Auto review | 中优先 | 借力点改为可选组合包机制：官方已把 Auto review 经 `8059d76ea3` 改为随安装交付、默认关闭的选项，这比直接移植其 701 行策略更适合本地 |
| invariant 精简 | 规则级分歧 | 维持。本地 `packages/AGENTS.md` 的规则与官方不同，需先改规则再清理 |

## 6. 执行顺序

**第一批**：`turnTail` 链改列表（0.5 天）与已知站点链接标记、菜单键盘模型。

**第二批**：git 快照接入本地 `session-file-revisions`（2 至 3 天），这是本次投入产出比最高的一项。

**第三批**：子代理限额与委托深度默认（1 至 2 天）。

**第四批**：插件管理器的 `boot/hmr` 与 `profileContext` 前置（后续服务层移植的前提）。

**持续搁置**：E2B 与 SSH 取舍、会话格式版本化、PTC 执行后端迁移，前两项需先完成决策，第三项是安全边界问题，应在资源允许时优先于前两项。
