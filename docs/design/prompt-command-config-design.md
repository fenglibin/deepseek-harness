# 配置驱动的提示词命令（Prompt Command）设计文档

本文记录「提示词命令」特性的完整设计：从需求对齐、方案决策，到架构与数据流，作为实现与验收的依据。决策的「为什么」与「放弃项」见对应 Agent Note（`.agents/notes/implemented/feature/2026-09-03-prompt-command-kind.md`）。

## 1. 背景与动机

会话输入 `/` 弹出的菜单里，原本有两条并行的命名空间：

| | Command（命令） | Skill（技能） |
|---|---|---|
| 注册方式 | `ctx.commands.register({ name, description, handler })` | `SKILL.md` 文件或 `ctx.skills.register()` |
| 行为 | `handler` 直接执行，不产生模型消息 | 命中 `/name` 后把正文作为指令注入模型上下文 |
| 是否需要代码 | 需要（handler 是 JS 函数） | 不需要（纯 Markdown 文件） |

用户的核心诉求是一种「介于两者之间」的能力：**日常常用提示词的快捷方式**——它既要发送给模型执行（像 Skill），又要足够轻量、维护方便（像 Command），并且增删时**不需要改代码**，最好能在「设置」里可视化配置。

经过对齐，明确三点：执行语义上「发给 LLM」、维护形态上「轻量配置」、落地位置上「command 内部二分」，而不是复用 skill。

## 2. 需求

1. 在现有 command 中引入第二种执行类型：**代码逻辑命令**（`code`，现有行为）与 **LLM 执行命令**（`prompt`，新增）。
2. `prompt` 命令：用户输入 `/name` 后，把配置的提示词文本作为**一条用户消息**发给模型（等价于用户自己打出这段话），模型正常回复。
3. 命令支持**中文显示名**：`/` 弹窗里优先显示中文名，缺省回退英文 kebab 名。
4. **配置驱动**：命令的英文名、中文名、提示词内容等存于配置文件，增删命令不改代码。
5. **设置界面**：支持增、删、改；删除需**二次确认**；注重交互体验。

## 3. 方案决策

### 3.1 决策 A：在 `CommandDefinition` 上做判别式分型

现有 `CommandDefinition` 增加 `kind: 'code' | 'prompt'`（缺省 `code`）：

- `code`（现有，向后兼容）：`handler` 直接执行。
- `prompt`（新增）：提供 `prompt` 文本，执行时提交给模型。

两型共享 `/` 菜单、生命周期日志（`command/run`/`command/done`）、作用域 shadowing 全套基础设施，仅在 `execute()` 分支处区分。同时 `CommandDefinition`/`CommandDescriptor` 增加可选的 `title` 字段承载中文显示名。

### 3.2 决策 B：prompt 命令作为「用户消息」发出

`prompt` 命令执行时，调用 `agent.followup(createUserMessage(...))`，把提示词作为一条 `command-invocation` 来源的用户消息提交给模型。用户额外输入的内容（`/name <补充>`）作为补充行追加在提示词之后。该消息是普通用户消息，模型正常回复；`command/done` 记录 `success` 且不带文本，避免与模型回复重复渲染。

### 3.3 决策 C：配置里存双语字段

配置条目直接携带 `name`（英文 kebab，唯一 id）、`title`（中文显示名，可选）、`description`（英文描述）、`prompt`（提示词正文）、`hint`（可选输入提示）。前端按 `title ?? name` 显示，不接入 locale 字典（因为命令是运行时增删的，不适合硬编码字典）。

### 3.4 决策 D：走 settings 能力 + 设置界面

- **复用 settings 能力**（方案 A），而非独立 JSON 文件 + watcher。
- 配置插件注册 `prompt-commands` 设置命名空间；cordis.yml 的 `commands` 是组合 `base` 层，settings 是用户层。
- 设置界面支持**增、删、改**，删除用 `RiskConfirmation` 做**二次确认**（勾选确认后才可删除）。

## 4. 架构设计

### 4.1 命令分型（`packages/interaction/commands`）

- `CommandDefinition`：新增 `kind`、`prompt`、`title`，`handler` 改为可选（`code` 必填）。
- `normalizeDefinition`：归一化 kind，校验 `code`/`prompt` 的 `handler`/`prompt` 互斥。
- `execute()`：`prompt` 分支调用 `executePrompt()` → `agent.followup`；`code` 分支走原 handler。
- `CommandDescriptor` 透传 `title`；新增 `command-invocation` 消息来源（`MessageSourceMap`）。

### 4.2 配置驱动插件（`packages/interaction/command-prompt-config`）

- 注册 `prompt-commands` 设置命名空间（schema：`{ commands: [...] }`）。
- cordis.yml `commands` 为 `base`；settings 变化时通过 `scope.watch` 动态重注册命令；无 settings 时回退静态配置。
- 通过 `ctx.inject(['settings'], ...)` 实现 settings 可选。

### 4.3 设置界面（`packages/client/ui-settings-commands`）

- 注册 `settings.section` slot（id `prompt-commands`），挂到设置导航。
- `PromptCommandsController`：绑定 `prompt-commands` scope，提供整表提交。
- `PromptCommandsSection`：列表 + 新增/编辑入口 + 删除二次确认。
- `PromptCommandEditor`：新增/编辑表单（name/title/description/prompt/hint）。

### 4.4 前端中文名（`ui-input-trigger` + `ui-commands`）

- `InputTriggerCandidate` 增加 `title`；`MenuView` 渲染 `title ?? name`。
- `ui-commands` 的 `candidates()` 透传 `title`。

## 5. 数据流

1. 用户在设置页「提示词命令」增/删/改 → 整表写入 `prompt-commands` settings 命名空间。
2. `command-prompt-config` 监听到 settings 变化 → 重新注册对应 `kind: 'prompt'` 命令。
3. 用户在会话输入 `/` → 弹窗展示命令（中文名优先），含 prompt 命令。
4. 选中 `/name` 或回车 → `commands.execute()` → `executePrompt()` → `agent.followup` 把提示词作为用户消息发给模型。
5. 模型正常回复；提示词正文持久化在 `user/message`（source 为 `command-invocation`）。

## 6. 备选方案（已否决）

- **复用 Skill**：技能自带 frontmatter/`<skill_content>` 包裹/catalog 注入的负担，一行提示词不需要；且列表是扁平用户设置，非分层 provider 目录。
- **独立 prompt-command 注册表**：重复 `/` 菜单、生命周期日志、scope shadowing。
- **独立 JSON 文件 + watcher**：settings 已存 JSON 文档并拥有冲突围栏/脱敏，再建文件是重复实现。

## 7. 实现清单

- 命令内核：`packages/interaction/commands/src/{index,types}.ts`
- 前端中文名：`packages/client/ui-input-trigger/src/{types,client/MenuView.tsx}`、`packages/client/ui-commands/src/client/service.ts`
- 配置插件：`packages/interaction/command-prompt-config/`
- 设置界面：`packages/client/ui-settings-commands/`
- 挂载：`packages/preset/agent-presets/presets/standard/agent.cordis.yml`、`packages/bundle/web-app/cordis.patch.yml`
