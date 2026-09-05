# AGENTS.md

DeepSeek Harness 是一个一切皆插件的 Cordis agent harness（智能体框架）。修改 `packages/` 之前先阅读 [docs/architecture.md](docs/architecture.zh.md)；文档规范见 [docs/AGENTS.md](docs/AGENTS.md)。

## 预发布立场：地基优先于影响半径

**首个 tagged release 发布时删除本节。** 在此之前，优先保证地基正确，而非做兼容垫片：可自由重命名或重新打包，并更新所有引用。后端会拒绝旧的磁盘格式。SQLite 使用单调递增的 `SCHEMA_VERSION`；`dsh-session` 将 `SESSION_FORMAT_VERSION` 保持在 `0`，不提供任何兼容性承诺。

**应用启动。** 只有 `dsh` profile 可以启动受支持的 Node 应用；package bin、demo 以及公开 SDK 的 argv 逃逸均在禁止之列（[规则](docs/architecture.zh.md#应用启动)）。

## 仓库布局

```
vendor/  内置的 Cordis 源码 — manifest 与同步流程见 vendor/README.md
packages/  @deepseek-ai/dsh-<pkg> workspace，位于 packages/<group>/<pkg>/
  core/   产品 API 主干：session、system-prompt、tools、agent、agent-loop
  api/    Remote BFF 组装与 Typert RPC 网关
  typert/  类型图生成器、加载器与运行时注册表
  llm/    LLM 能力：Service Definition/Consumer + DeepSeek 提供方
  e2b/    E2B 概念验证（POC）：沙箱 + FS/subprocess 适配器
  shell/  bash 能力：Service Definition + local/pwsh 提供方 + shell Consumer
  subprocess/  subprocess 能力 + 本地进程树提供方 + 共享 Win32 库
  terminal/  持久会话
  fs/     文件系统能力 + 策略
  lsp/    language-server 能力
  skill/  skill provider 注册表 + 本地实现 + catalog/loader 工具
  web/    web 能力：Service Definition + search/fetch 提供方 + tool Consumer
  compaction/  compaction 能力 + 基础提供方
  context/  request-context 插件
  subagent/  subagent 能力：Service Definition + 提供方 + delegation Consumer
  bundle/  可安装的 dsh --profile patch-layer bundle
  workflow/  workflow 能力 + worker-thread 提供方 + tool Consumer
  webhook/  webhook 入口
  todo/    todo_write 工具
  plan/    以记录状态（logged state）呈现的 plan 模式
  preset/  从 preset cordis.yml 文件进行按会话的 agent 组合
  guard/   loop-hygiene + tool-timeout 插件
  self-modification/  agent 检查并挂载自己的插件
  hooks/   Claude Code/Codex hook 桥 + wire-protocol 库
  session/  持久会话数据：持久化、投影、标题、遥测
  identity/  匿名身份
  settings/  用户设置能力 + 文件提供方
  credentials/  credential/authorization 能力 + env/.env 提供方
  acp/     仅自动化使用的 Agent Client Protocol 服务器
  interaction/  approval/interaction 能力、权限、命令、ask-user
  boot/    共享 profile/应用启动胶水
  sdk/     JSON-RPC 协议 + TypeScript 客户端/服务器
  examples/  可复用的组合 bundle（agent-spine）
  experimental/  排除在正式发布之外的私有原型
  support/  开发/测试基础设施
  util/    零依赖工具库
python/  Python SDK 与内置运行时（见 python/README.md）
native/  @deepseek-ai/node-addon-landlock-run 的源记录（见 native/README.md）
.agents/  Agent 工作流与 Agent Notes（`notes/`）
docs/    架构、生成目录、事后复盘、cookbook（见 docs/AGENTS.md）
scripts/  仓库 gate 与生成器
website/  选定双语 docs/ 源的 VitePress 投影
```

Package 分组：[packages/README.md](packages/README.zh.md)。

## 命令

```sh
pnpm install            # pnpm workspaces，node ^22.19 || >=24
pnpm run clean           # 移除构建产物与已删除 package 的安全残留
pnpm run test           # 单元测试
pnpm run test:coverage  # CI 覆盖率门禁：packages/*/*/src 上每个文件 100%
pnpm run test:e2e       # 真实 API 测试；无 DEEPSEEK_API_KEY 时自行跳过
pnpm run test:expected  # 各 owner 本地的进程期望输出
pnpm run test:snapshot  # 通过随附 profile 回放无密钥录制的会话；过滤：-t <name>
pnpm run test:snapshot:record  # 重新录制期望输出（需要 key）
pnpm run typecheck
pnpm run lint
pnpm run duplication    # 跨文件 TypeScript 克隆检测
pnpm run build          # tsc 产出 lib/types，tsdown 打包 runtime
pnpm run hygiene        # publint + workspace/package/依赖检查 + NodeNext consumer 检查
pnpm run check:windows-wine  # 仅在诊断已知 Windows 故障时使用（需要 wine）；该信号由 CI 负责
pnpm run doc-sync       # 所有文档门禁；叶子清单见 scripts/run-gates.ts
pnpm run test:docs      # 快速文档检查（不构建；doc-quick 聚合）
pnpm run website:build  # VitePress 构建（兼作死链检查）
pnpm dsh --profile headless "task"  # 从源码运行一个任务（需要 DEEPSEEK_API_KEY）
pnpm run demo:ptc -- "task"  # headless PTC 模式运行（需要 key）
```

### 宿主机沙箱失败

若必需的 `gh`、`pnpm`、build、test 或 generator 命令因沙箱拦截凭据、网络、IPC、文件监听或嵌套 `sandbox-exec` 而失败，请以最窄的宿主机提权方式原样重试。必须要有沙箱证据；绝不绕过测试失败或产品沙箱。

### 在本地运行相关检查

推送前通过 [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md) 运行检查；只汇报实际运行过的命令。`gh stack sync` 之后立即验证；检查未通过前不要合并。

- 让证据与改动面匹配：聚焦的行为测试、模型/用户输出快照、文档走 `doc-sync`、已发布路径走构建冒烟、提供方走真实 API e2e。
- 提交或推送时永远不要默认跑全套，也不要重复跑已经通过的检查。穷尽式覆盖与平台矩阵由 CI 负责；只有被显式要求、排查 CI、或确实是无法拆分的全仓库变更时，才在本地完整预演。
- CI 的覆盖率门禁是 `test:coverage` 而不是 `test`（[为什么](docs/testing.zh.md)）。

## 密钥 / .env

真实 API 测试与 demo 读取 `DEEPSEEK_API_KEY`、可选的 `DEEPSEEK_BASE_URL` 以及根目录 `.env`。cordis.yml 在 plugin `config` 与条目 `disabled` 下允许 `!!js`（绝不使用 `!js`）；其余元数据保持字面量，因此条件组合也使用 overlay（[入门](docs/cordis-primer.zh.md#loader-configuration)）。绝不提交凭据。无 key 时 CI e2e 会跳过；key 策略由 [testing.md](docs/testing.zh.md) 负责。

## 约定

- 每个 npm package 都是 `@deepseek-ai/dsh-<name>`；vendor 包会重新设定 scope（[映射](docs/rescope.zh.md)）且为 `private: true`。`@deepseek-ai/cordis` 是每个 harness package 的 peerDependency（+ dev）。
- 处处使用 ESM（`"type": "module"`）。跨 package 使用包名，本地相对导入使用 `.ts`。配置子进程在纯 Node 下运行构建后的 `lib/`；源码回归测试使用其声明的启动器（[测试策略](docs/testing.zh.md#测试子进程启动模式)）。`dsh` CLI 源码启动经由 tsx 的 ESM-only hook（`node --import tsx/esm`）运行；它触达的模块必须保持 ESM（不能只有 CJS 导出）——在 engines 覆盖范围内 Node 的原生 TypeScript 模式不可用（[源码启动契约](.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md)）。Raw/Web 的 `cordis.yml` 裸插件必须出现在其 resolver manifest 的 `dependencies` 中；`verify-cordis-config` 强制此项。
- **注册即副作用（effects）**：所有贡献都经由 `ctx.effect()` / `ctx.on()`；registry 的 `register()` 返回 disposer。
- **运行时不变式断言的是归属关系。** 检查权威事件流或可变数据，而不是 service/方法是否存在、plugin 元数据或 effects，也不是固定的纯示例。没有合理关系时，一个有解释的空伴生（companion）才是正确的（[package 不变式规则](packages/AGENTS.md)）。
- **类型化事件使用声明合并（declaration merging）**与可合并扩展的 map。事件 JSDoc 需要 `@mode` 与 payload 的 `@param`；payload 中不出现的 scoped key 需要 `@dshScopeScan unsupported`。公共 service 方法要记录参数与非 void 返回值。`SessionEventMap` 成员默认 required-on-read——不识别某类型的构建会拒绝写入日志，除非该事件带信封的 `ignorable: true`；只有结构性格式变更才提升 `SESSION_FORMAT_VERSION`（[机制](.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)）。
- **基于判别标签（discriminant tags）进行 switch。** 封闭联合以 `assertNever` 收尾；可合并扩展的联合落到有文档说明的默认分支。
- **Waterfall 监听器必须调用 `next()`** 来转交；不调用即返回会短路整条链（[语义](docs/cordis-primer.zh.md#cordis-waterfall-semantics)）。
- **模型可见 ⟺ 已记录（logged）**：任何进入模型请求的内容都必须能从 session 日志重建；新增的模型可见输入需要一个 session 事件。
- **加插件，不改 loop**：新行为放在有文档说明的扩展点上；改动 `agent-loop` 需要同步更新 docs/architecture.md。
- **一个能力接缝（capability seam）由 Service Definition / Service Provider / Consumer 三种角色构成。** 它是完整的整体，绝不只是一个角色；只有当各角色独立演进时才拆分（[术语表](docs/glossary.zh.md#capability-seam)）。
- **优先使用有维护的依赖而不是自己手写**，前提是它们确实能删掉自有代码与测试（[策略](.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.zh.md)）。
- **package 边界处显式优于隐式**：默认值在属主实现中是一个显式的 `resolve(request): Spec` 步骤，绝不是在 `run()` 里藏一个 `?? default`（`dsh-shell` 的 request/spec 拆分是范本）。
- **plugin 中不允许硬编码可调项**：随部署变化的选项必须是可从 cordis.yml 修改的、经校验的 `Config` 字段；`DEFAULT_*` 常量或测试 hook 不构成可配置性。协议常量、外部规格与安全不变式保持固定。
- **错误配置要大声失败（fails loud）**：能自包含判断时在加载期失败，否则在最早可判定的点失败；绝不静默跳过缺失的引用对象。
- **跨边界的非透明 id 必须打标（branded）**（用 `dsh-brand` 的 `Branded<B>`），绝不用裸 `string`。
- **在类型化的同进程边界信任 TypeScript。** 不要仅为静态接口已要求的取值添加运行时校验、回退行为或对抗性输入测试；要在 parser/config、queued、model/tool JSON、durable/file、worker、process 与 wire 边界做校验。
- **源码面（source plane）与产物面（artifact plane）绝不混用。** 静态 gate 与测试通过 tsconfig `paths` 将 workspace 导入解析到 `src`，并在干净树上通过；消费构建产物 `lib/` 的 gate 必须声明该依赖（[布局](docs/development.zh.md#typescript-project-layout)）。
- **保持编译面（compiler faces）显式。** 同时含 Host 与 Client 程序的 package 要暴露面级 leaf 配置与仅含 solution 的根配置；仓库级程序从某个面配置播种，绝不用根 solution（[布局](docs/development.zh.md#typescript-project-layout)）。
- **空的 `catch` 要说明吞掉了什么**以及为什么不会有别的东西到达这里；`try` 只包一条语句。
- **让注释保持局部。** 不复述代码；除非本地确有必要，否则不解释远处行为，也不扩充无关注释（[依据](.agents/notes/implemented/process/2026-08-09-concrete-prose-names-actors-and-recorded-facts.zh.md)）。
- **并行取值优先对称**；无法解释的不对称通常意味着漏做了抽取。
- **测试描述行为，而不是正确性。** 行为过时了就连同测试一起改；在 PR 里解释原因。
- **非平凡变更必须在同一 PR 中包含一条 Agent Note；** 只有机械式/局部编辑可豁免（[范围](.agents/notes/README.zh.md#when-to-write-one)）。已归档的 notes 是冻结的：绝不修改，也不把它们当作当前权威（[归档策略](.agents/notes/README.zh.md#归档与删除)）。
- **Client UI 文案归 locale 所有。** 产品文本要经类型化字典与 `t` 或本地化 primitive props 路由；`verify-client-ui-i18n` 拒绝硬编码文案（[决策](.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)）。
- **测试策略** — [docs/testing.md](docs/testing.zh.md)。每个非平凡的、模型或产品用户可见的变更都要更新无密钥的录制会话快照；[快照归属](snapshots/AGENTS.md)将顶层目录树保留给会话驱动用例，其余期望输出保持 owner-local。Fixture 在 macOS/Linux 上回放；修 fixture，不要修 normalizer。
- **提前设计每个工具的 UI 呈现。** Host presenter 保持纯函数；Web 卡片从原始事件与持久化的结果元数据派生（[cookbook](docs/cookbook/adding-a-tool.zh.md)）。
- **为能力接缝、生命周期路径与 transcript 输出规划 unit、e2e 和 snapshot 覆盖**；缺失的 snapshot-harness 支持要并入同一变更。
- **两个 SDK 都投影 loop。** Agent-loop、session-lifecycle 与 `SessionEventMap` 的变更要在同一 PR 中更新 TypeScript 与 Python SDK 的期望输出；`pnpm run test` 两者都不覆盖（[面](docs/testing.zh.md#何时需要快照测试)）。
- **审慎选择 PR 历史。** 拆分相互独立的变更；传播前先修好引入问题的 PR。独立/stack 分支可以 merge-forward 或 rebase。重写使用 `--force-with-lease`，远端有移动就中止，绝不使用裸 `--force`；在改取更新的 base 之前，先保存进行中的 merge-forward 检查点（[依据](.agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.zh.md)）。
- **标签：** 每个 PR 一个 `kind/*`，所有实质内容打 `area/*`，并填原生 Issue Type（[分类法](.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.zh.md)）。
- TODO 标记：按紧急程度使用 `FIXME`/`TODO`/`XXX`（[语义](docs/development.zh.md)）。
- 文件以恰好一个尾部换行结束；`git diff --cached --check`（pre-commit）把关。

## 防御性模式（Defensive patterns）

做生命周期、并发、子进程或 teardown 相关工作前，先阅读 [docs/defensive-patterns.md](docs/defensive-patterns.zh.md)。

## 类型安全与文档

所有代码在 `strict: true` 与 `noImplicitAny` 下编译；任何剩余的 `any` 都要解释为何无法收窄。每个模块与导出对其非显而易见的契约都有简洁 JSDoc；函数式导出包含 `@param`/`@returns`，由 `verify-export-jsdoc` 强制执行。继承声明的成员、plugin 协议槽位与构造函数，其文档保留在声明处的 Service Definition、协议或类中。

注释与文档陈述的是完整契约与上下文，而不是推理过程记录。使用直接、具体的措辞，不使用隐喻。在写 `contract`、`boundary` 或 `shape` 之前，先问是否有更精确的词能命名该主题：写 `response fields`、`JSON validation` 或 `ESM exports`，而不是 `response shape`、`validation boundary` 或 `module shape`。`contract` 只用于前置条件、后置条件、不变式、兼容性承诺，以及其他调用方、被调方、实现者、提供方、生产者或消费者所依赖的义务。`boundary` 只用于字面意义上的进程、wire、安全、事务或生命周期边界。不要叙述控制流或测试过程、保留评审历史，或复述代码。保留关于行为、失败、时序、归属与安全使用的实事，并链接到其依据。决策时使用 [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md)。把可机械检查的不变式接入一个被执行的最顶层 gate，并证明每条被改动的验收路径都会拒绝非法用例。使用狭窄且有依据的例外，而不是全局禁用某条规则。

每个代码变更都伴随文档：同步更新受影响的 README 与 JSDoc 契约。常规双语工作遵循 [docs/AGENTS.md](docs/AGENTS.md)；只有用户显式调用才能运行 `dsh-translate-docs`。当前态行文、每段一个物理行、每项实事只有一个归属、以及词数预算，都在该文件中定义。

## 编辑这些指令

根目录与 `packages/` 下的 `CLAUDE.md` 是指向 `AGENTS.md` 的符号链接；要编辑真实文件。保持每条规则自包含，同时链接高层文档。在清晰度不受损时压缩内容；当必需内容确实需要更多空间时，调高 `verify-doc-budgets` 上限。

## 内置依赖（Vendoring）策略

`vendor/` 下的 packages 是锁定版本的源码拷贝（manifest 连同上游 SHA 见 [vendor/README.md](vendor/README.md)）。按其中的同步流程更新；重新应用或撤除已记录在案的本地修改；重跑 `pnpm run test && pnpm run build`。

<!-- CODEGRAPH_START -->
## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### 🚫 Mandatory rules — do NOT skip

These are **rules**, not suggestions. Models that haven't been
fine-tuned on codegraph (DeepSeek, Qwen, GLM, HunYuan, …) often fall back to
grep/Read by training-data habit even when codegraph is faster.

1. **NEVER grep / find / Read to look up a symbol by name.** Use `codegraph_search` or `codegraph_context` first.
2. **NEVER chain Read + grep to trace how something works.** Use `codegraph_context` (one call) plus ONE `codegraph_explore`.
3. **NEVER call `codegraph_node` more than 3 times in a row.** Switch to `codegraph_explore` which batches by file in a single capped call.
4. **NEVER trust an edge tagged `[heur 0.NN ⚠️]` (confidence < 0.7) without verifying.** Open the call site to confirm before relying on the relationship.
5. **NEVER answer when the response footer shows `⚠️ Index age:` over 30 minutes.** Ask the user to run `codegraph sync`, or check `codegraph_status`.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | `codegraph_search` |
| "What calls function Y?" | `codegraph_callers` |
| "What does Y call?" | `codegraph_callees` |
| "What would break if I changed Z?" | `codegraph_impact` |
| "Show me Y's signature / source / docstring" | `codegraph_node` |
| "Give me focused context for a task/area" | `codegraph_context` |
| "See several related symbols' source at once" | `codegraph_explore` |
| "What files exist under path/" | `codegraph_files` |
| "Is the index healthy?" | `codegraph_status` |

### Rules of thumb

- **Answer directly — don't delegate exploration.** For "how does X work" / architecture / trace questions, answer with 2-3 codegraph calls: `codegraph_context` first, then ONE `codegraph_explore` for the source of the symbols it surfaces. Codegraph IS the pre-built index, so spawning a separate file-reading sub-task/agent — or running a grep + read loop — repeats work codegraph already did and costs more for the same answer.
- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **Don't loop `codegraph_node` over many symbols** — one `codegraph_explore` call returns several symbols' source grouped in a single capped call, while each separate node/Read call re-reads the whole context and costs far more.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"*

---

## CodeGraph（中文）

本项目已配置 CodeGraph MCP 服务（`codegraph_*` 工具集）。CodeGraph 基于
tree-sitter 解析了项目中每一个符号、关系和文件，读取耗时亚毫秒级，能够返回
grep 无法提供的结构化信息。

### 🚫 强制规则 —— 必须遵守

以下是**强制规则**，不是建议。未经 codegraph 微调的模型（DeepSeek、Qwen、
GLM、HunYuan 等）常因训练习惯而退回 grep / Read，即使 codegraph 更快。请严格遵守：

1. **绝不**用 grep / find / Read 按名查找符号。优先调用 `codegraph_search` 或 `codegraph_context`。
2. **绝不**用 Read + grep 串联来追踪 X 是怎么工作的。一次 `codegraph_context` 加一次 `codegraph_explore` 即可。
3. **绝不**连续调用 `codegraph_node` 超过 3 次。切换到 `codegraph_explore` —— 它一次按文件聚合返回全部源码。
4. **绝不**信任置信度 < 0.7 的关系边（被标 `[heur 0.NN ⚠️]`）。先用 `codegraph_node` 或 Read 该行确认调用关系，再做出依赖性判断。
5. **绝不**在响应底部出现 `⚠️ Index age:` 且超过 30 分钟时直接回答。先让用户执行 `codegraph sync`，或用 `codegraph_status` 确认 watcher 状态。

### 何时优先用 codegraph 而非原生搜索

涉及**结构性**问题（谁调用谁、改了会破坏什么、X 在哪定义、X 的签名是什么）
请用 codegraph；只在查询**字面文本**（字符串内容、注释、日志消息）或已经
打开了具体文件时，才使用原生 grep/read。

| 问题 | 工具 |
|---|---|
| "X 在哪定义？" / "找名字叫 X 的符号" | `codegraph_search` |
| "谁调用了函数 Y？" | `codegraph_callers` |
| "Y 调用了哪些东西？" | `codegraph_callees` |
| "改 Z 会影响哪些地方？" | `codegraph_impact` |
| "看 Y 的签名 / 源码 / docstring" | `codegraph_node` |
| "针对某个任务/区域给我聚焦的上下文" | `codegraph_context` |
| "一次性看几个相关符号的源码" | `codegraph_explore` |
| "path/ 下有哪些文件" | `codegraph_files` |
| "索引是否健康？" | `codegraph_status` |

### 经验法则

- **直接回答 —— 不要把探索委派给子任务/子代理**。对"X 是怎么工作的"/架构/追踪类问题，用 2-3 次 codegraph 调用即可：先 `codegraph_context`，再一次 `codegraph_explore` 拿涉及符号的源码。codegraph 本身就是预建好的索引，再去派生一个文件读取的子代理、或自己跑 grep + read 循环，是在重复 codegraph 已经做完的工作，且成本更高。
- **信任 codegraph 的结果**。它们来自完整的 AST 解析；不要再用 grep 二次验证 —— 那样更慢、不准、还浪费上下文。
- **按名查找符号时不要先 grep**：`codegraph_search` 一次返回种类、位置、签名。
- **不要串 `codegraph_search` + `codegraph_node`**：想要上下文就直接用 `codegraph_context`（一次调用搞定）。
- **不要对一堆符号循环调用 `codegraph_node`**：一次 `codegraph_explore` 就按文件聚合返回它们的源码；逐个 node/Read 会反复读取整段上下文，成本高得多。
- **索引延迟**：文件 watcher 会去抖约 500ms；编辑文件后不要在同一轮立刻再查询。

### 如果 `.codegraph/` 不存在

MCP 服务会返回 "not initialized."。请询问用户："*我注意到这个项目还没有初始化 CodeGraph，要我运行 `codegraph init -i` 来构建索引吗？*"
<!-- CODEGRAPH_END -->
