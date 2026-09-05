---
description: "配置驱动的提示词快捷命令：注册可复用的 /name 斜杠命令，其提示词文本提交给模型，无需为每个命令编写代码。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-prompt-config

## 概述

`dsh-command-prompt-config` 将一组经过校验的提示词命令条目注册为 `kind: 'prompt'` 斜杠命令。新增一个可复用的提示词快捷方式——例如常用的代码审查或总结指令——无需编写任何代码，只需修改配置。每个条目包含命令名、可选的中文显示名、发现描述，以及调用时作为一条用户消息提交给模型的提示词文本。当你想要轻量、由配置承载的提示词快捷方式，而不是代码承载的命令处理器或完整的 `SKILL.md` 技能时，选择它。

## 目录

- [使用本包](#使用本包)
- [源码映射](#源码映射)
- [已知限制与后续工作](#已知限制与后续工作)

## 使用本包

以 `commands` 列表装配该插件。每个条目注册一个 `/name` 命令，其 `prompt` 文本作为携带 `command-invocation` 来源的用户消息提交给模型；可选的 `title` 提供本地化显示名，`description` 是发现摘要，`hint` 声明自由文本输入，使编辑器接管该行以接收额外参数（追加在提示词文本之后）。

```yaml
- id: command-prompt-config
  name: '@deepseek-ai/dsh-command-prompt-config'
  config:
    commands:
      - name: code-review
        title: 代码审查
        description: review the current diff
        prompt: 请审查本次代码变更，重点关注正确性、可读性与边界情况。
        hint: '<补充要求>'
```

### 命令行为

| 输入 | 结果 |
|---|---|
| `/code-review` | 将配置的 `prompt` 文本作为一条用户消息提交给模型。 |
| `/code-review 重点看性能` | 提交 `prompt` 文本，随后追加额外参数作为补充行。 |

命令本身不渲染输出：模型的回复走普通轮次路径，提示词正文持久化在产生的 `user/message` 事件中（其来源标注了命令名）。

### 装配方式

该插件注入命令注册表。自定义应用需挂载注册表宿主与本插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-prompt-config
  name: '@deepseek-ai/dsh-command-prompt-config'
```

内置的 `standard` agent preset 以空 `commands` 列表挂载本插件，部署方通过编辑 preset 配置按需启用。

## 源码映射

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：提示词命令配置 schema 与注册 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴随：空（无运行时不变式——命令注册表负责校验） |

## 已知限制与后续工作

- **仅提示词文本** — 条目携带静态提示词文本与可选自由文本后缀；不支持模板占位符或参数替换。
- **不支持逐命令图片** — 提示词条目不声明图片接受；携带图片的编辑器提交会被拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
