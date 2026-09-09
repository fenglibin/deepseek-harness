---
description: "提示词命令设置页：可编辑的常用提示词快捷方式列表，支持新增、编辑和二次确认删除。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-commands

## 概述

`dsh-client-ui-settings-commands` 提供「提示词命令」设置页。它编辑 `prompt-commands` 设置命名空间——即 `@deepseek-ai/dsh-command-prompt-config` 注册的可复用 `/name` 提示词快捷方式列表。列表通过分步编辑器支持新增与编辑，删除则经过页内风险确认，使每次改动都显式且可追溯。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将它装配在设置外壳和 Host 端 `command-prompt-config` 插件旁。命名空间未被提供时该页不显示有意义内容，但入口始终注册。

```yaml
- id: ui-settings
  name: '@deepseek-ai/dsh-client-ui-settings'
- id: ui-settings-commands
  name: '@deepseek-ai/dsh-client-ui-settings-commands'
```

内置 Web 应用将其挂在「插件」页之后。Host 端命名空间由 `@deepseek-ai/dsh-command-prompt-config` 以 `prompt-commands` 注册；两个包共享该命名空间名，但彼此无运行时依赖。

### 页面交互

页面展示当前命令列表，每行显示 `/<name>` 和可选的显示标题。用户可执行以下操作：

- **新增**—点击「添加命令」按钮，打开编辑器填写命令名、显示名称（可选）和提示词内容。
- **编辑**—点击行上的「编辑」按钮，修改现有命令的字段。
- **删除**—点击行上的「删除」按钮，触发 RiskConfirmation 对话框，用户需勾选确认后执行删除。

每次确认的改动以一次原子写提交整张列表，因此改动不会部分落地。

### 只读状态

当设置文档为只读时（如非 loopback 页面），页面显示只读提示，所有写操作按钮均禁用。

### 源码映射

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：在 `prompt-commands` scope 上注册设置页 slot |
| [`src/client/controller.ts`](src/client/controller.ts) | 页面模型：草稿规范化与整表写入 |
| [`src/client/PromptCommandsSection.tsx`](src/client/PromptCommandsSection.tsx) | 列表、编辑器与删除确认界面 |
| [`src/client/PromptCommandEditor.tsx`](src/client/PromptCommandEditor.tsx) | 新增/编辑表单 |
| [`src/client/locales.ts`](src/client/locales.ts) | 简体中文字典，含所有 UI 文案键 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴随：空 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 注册

浏览器插件入口（`src/client/index.ts`）通过 `ctx.settingsScope.bind({ namespace: 'prompt-commands' })` 绑定设置命名空间，然后在 `settings.section` slot 上注册 `PromptCommandsSection` 组件，order 为 `16`，位于其他设置分区之后。

### PromptCommandsController

`PromptCommandsController` 类（`src/client/controller.ts`）封装了与设置 scope 的交互：

- `commands()`——返回当前命令列表（命名空间未提供时返回空数组）。
- `snapshot()`——返回当前 scope 快照，包含 `status`、`writable` 和 `value`。
- `subscribe()`——订阅 scope 变化。
- `commit(commands)`——以一次原子 `mutate` 操作写入整张命令列表。

### 命令名校验

`normalizeDraft` 函数执行命令名验证：命令名必须匹配 `/^[a-z][a-z0-9_-]*$/`，且命令名和提示词内容均不能为空。空白标题在存储时被省略。

### 编辑器状态管理

`PromptCommandsSection` 组件使用 React `useState` 管理编辑器状态（`EditorState`），包含 `index`（`null` 表示新增，数字表示编辑第几条）和 `draft`（当前草稿）。删除操作使用 `RiskConfirmation` 组件，用户需先勾选确认按钮才能执行删除。

### 命名空间声明合并

本包通过 TypeScript 声明合并将 `'settings.commands'` 注册到 `LocaleNamespaceMap`，使 `t` 函数获得类型安全的多语言键。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置外壳和 Host 侧命令提供方。

- [ui-settings](../ui-settings/README.zh.md)——设置领域底座，提供 `ctx.settingsScope` 和 `settings.section` slot。
- [ui-settings-general](../ui-settings-general/README.zh.md)——设置外壳：导航与界面框架。
- [command-prompt-config](../../host/command-prompt-config/README.zh.md)——Host 侧 `prompt-commands` 设置命名空间的提供方。
- [ui-primitives](../ui-primitives/README.zh.md)——提供 `RiskConfirmation` 和 `Button` 组件。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端设置页面，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **暂不支持拖拽排序** — 命令保持配置顺序；排序为后续增强。
- **整表写入** — 每次确认的改动以一次原子写提交整张列表，正确但不最小化。
- **无导入/导出** — 不支持批量导入或导出命令列表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>