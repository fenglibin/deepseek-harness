# Agent Note：交付纪律工具接入 Web 预设

Status: implemented

[English](2026-09-03-delivery-tools-web-preset-wiring.md) | 中文

## 问题

交付纪律能力已在 base bundle 中交付（`delivery` + `tool-delivery`，B1–B5 批次），却从未真正进入 Web 会话。Web 界面禁用了 base 里所有 agent-plane 工具行、改由每个会话挂载预设，但 `tool-delivery` 既没有被那里禁用、也没有被任何预设挂载，且没有任何 system-prompt 段落告诉模型何时使用这些工具。结果是：Web 应用里的编码智能体回退到 `todo_write` 来跟踪工作，因此从不写入 `.dsh/changes/` 或 `.dsh/design/` 产物，设计/拆分门禁被静默绕过。

第二个独立的缺口：`todo_write` 会话行展开后显示的是原始 JSON 参数，而不是可读的列表。

## 决策

按与 `tool-goal` 相同的方式，把交付工具接入 Web 界面：

- `packages/bundle/web-app/cordis.patch.yml` 与其他 agent-plane 工具并列禁用 `tool-delivery`，且每个携带工具的预设（`standard`、`cordis`、`ptc`）在 `tool-todo` 旁以 `enforcement: stateful` 挂载 `@deepseek-ai/dsh-tool-delivery`。
- `@deepseek-ai/dsh-tool-delivery` 现在注入 `systemPrompt` 并注册一个 `tool:delivery` 引导段（顺序 `TOOL_DELIVERY` = 2450），告诉模型：当工作必须留下设计或变更记录时，优先使用交付工具而非 `todo_write`，并逐字复制确切的 `task_id`/`revision`。
- `todo_write` 会话行现在渲染结构化的 `TodoCard` 列表（状态标记 + 任务文本 + 本地化状态标签），而非原始 JSON 参数；参数不可用时回退到原始正文。

## 备选方案

**让交付工具只停留在 host-plane。** 否决：Web 界面的预设模型把每个 agent-plane 工具都移到预设之后；在禁用其同级工具的同时让 `tool-delivery` 留在 host-plane，正是把它从会话中藏起来的那个不对称。

**仅依赖工具描述本身。** 否决：交付工具的描述偏抽象；没有专门的引导段，模型会默认使用 `todo_write`，因为这符合它的任务清单习惯。

**为会话行复用 input-dock 的 `TodoPanel`。** 对会话行否决：`TodoPanel` 是 composer dock 对 `todos` 的实时投影；会话行需要的是由调用参数推导出的普通卡片，而不是会话投影。

## 后果

- **获得** Web 编码智能体现在能看到并被引导到交付工具，因此较大工作会写入 `.dsh/changes/` / `.dsh/design/` 产物并通过设计/拆分门禁；`todo_write` 行展开为可读列表。
- **代价** `tool-delivery` 上新增 `@deepseek-ai/dsh-system-prompt` peer 依赖与 tsconfig 引用、一个新的 `TOOL_DELIVERY` 段顺序，以及一个新的 `TodoCard` 客户端组件加三个 `todo.status.*` 语言键。
- **测试** 三个新测试（预设挂载、引导段、结构化列表展开）；`tool-delivery`、`system-prompt`、`ui-tool`、`ui-conversation`、client-i18n 与 cordis-config 门禁全部通过。
