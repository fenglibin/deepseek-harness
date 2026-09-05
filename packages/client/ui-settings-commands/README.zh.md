---
description: "提示词命令设置页：可编辑的常用提示词快捷方式列表，支持新增、编辑和二次确认删除。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-commands

## 概述

`dsh-client-ui-settings-commands` 提供「提示词命令」设置页。它编辑 `prompt-commands` 设置命名空间——即 `@deepseek-ai/dsh-command-prompt-config` 注册的可复用 `/name` 提示词快捷方式列表。列表通过分步编辑器支持新增与编辑，删除则经过页内风险确认，使每次改动都显式且可追溯。

## 目录

- [使用本包](#使用本包)
- [源码映射](#源码映射)
- [已知限制与后续工作](#已知限制与后续工作)

## 使用本包

将它装配在设置外壳和 Host 端 `command-prompt-config` 插件旁。命名空间未被提供时该页不显示有意义内容，但入口始终注册。

```yaml
- id: ui-settings
  name: '@deepseek-ai/dsh-client-ui-settings'
- id: ui-settings-commands
  name: '@deepseek-ai/dsh-client-ui-settings-commands'
```

内置 Web 应用将其挂在「插件」页之后。Host 端命名空间由 `@deepseek-ai/dsh-command-prompt-config` 以 `prompt-commands` 注册；两个包共享该命名空间名，但彼此无运行时依赖。

## 源码映射

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：在 `prompt-commands` scope 上注册设置页 slot |
| [`src/client/controller.ts`](src/client/controller.ts) | 页面模型：草稿规范化与整表写入 |
| [`src/client/PromptCommandsSection.tsx`](src/client/PromptCommandsSection.tsx) | 列表、编辑器与删除确认界面 |
| [`src/client/PromptCommandEditor.tsx`](src/client/PromptCommandEditor.tsx) | 新增/编辑表单 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴随：空 |

## 已知限制与后续工作

- **暂不支持拖拽排序** — 命令保持配置顺序；排序为后续增强。
- **整表写入** — 每次确认的改动以一次原子写提交整张列表，正确但不最小化。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
