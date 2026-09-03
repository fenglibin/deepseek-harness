# Agent Note: prompt-command kind and configuration-driven prompt shortcuts

Status: implemented

[English](2026-09-03-prompt-command-kind.md) | 中文

## Problem

斜杠命令此前只有一种形态：由代码持有的 `handler` 直接对接收 agent 执行，不产生模型消息。用户还想要轻量、可复用的提示词快捷方式——以 `/name` 调用的常用指令，它确实会提交给模型，但不带完整 `SKILL.md` 技能的仪式感（frontmatter、`<skill_content>` 包裹、catalog 注入）。这两种需求共享 `/` 菜单和生命周期日志，但「执行」的含义不同；而提示词快捷方式列表还必须能在不改代码的前提下由用户编辑。

## Decision

- `CommandDefinition` 新增 `kind: 'code' | 'prompt'` 判别字段（缺省 `code`）。`code` 命令直接运行其 `handler`；`prompt` 命令将其 `prompt` 文本作为一条携带 `command-invocation` 消息来源的用户消息提交给模型，额外的参数文本作为补充行追加。`CommandDescriptor` 新增可选的 `title` 用于本地化显示名；`/` 菜单渲染 `title ?? name`。
- `@deepseek-ai/dsh-command-prompt-config` 注册 `prompt-commands` 设置命名空间（schema：一个 `commands` 列表）。cordis.yml 的 `commands` 条目是组合 `base` 层；当组合了 settings provider 时，该 section 变为用户可编辑，插件在每次变化时重新注册匹配的命令；否则静态条目生效。
- `@deepseek-ai/dsh-client-ui-settings-commands` 新增「提示词命令」设置页：通过分步编辑器新增/编辑，通过页内风险确认删除，每次确认的改动以一次整表写入提交。

## Alternatives considered

- **复用技能** — 模型技能已经能加载 `/name` 手势并把正文注入模型。否决，因为技能带有包裹、catalog 和 frontmatter 的负担，而一行提示词快捷方式并不需要；且提示词快捷方式列表是一个扁平的用户设置，而非分层的 provider 目录。
- **独立的 prompt-command 注册表** — 并行注册表可保持 `command` 封闭。否决：一旦 `kind` 成为判别字段，它只会重复 `/` 菜单、生命周期日志和作用域遮蔽而无收益。
- **独立 JSON 文件加 watcher** — 更贴近字面意义的「一个 JSON 文件」。否决：settings 缝隙已经存储 JSON 文档、拥有冲突围栏和脱敏，且正是设置页所编辑的内容；第二个文件会重复实现这些。

## Consequences

- 一个 `/` 菜单现在在一个注册表、一套生命周期（`command/run`/`command/done`）和一个设置页下同时服务代码命令与提示词快捷方式。
- 提示词快捷方式端到端由配置持有：cordis.yml 提供部署默认值，`prompt-commands` 设置 section 提供用户覆盖，无需为每个命令编写代码。
- `command-invocation` 是新的消息来源，因此提示词提交可从会话日志重建。
