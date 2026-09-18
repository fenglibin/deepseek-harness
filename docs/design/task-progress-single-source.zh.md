# 会话页任务进度单一数据源方案

> 状态：已实现
> 目标读者：维护者
> 关联诉求：会话页左侧交付浮层与输入框上方面板必须显示同一份任务清单与同一份状态。
> 关联文档：[交付进度栏可用性方案](delivery-float-card-usability-rationale.zh.md)、[需求分析与进度呈现方案](delivery-discipline-analysis-progress-rationale.zh.md)

---

## 1. 背景与动机

同一会话页上有两个任务进度面板，它们显示同一个任务却给出互相矛盾的内容：

- **左侧交付浮层**（`DeliveryFloatCard`，槽 `conversation.side.float`）读 `delivery-tasks` 投影。
- **输入框上方面板**（`TodoPanel`，槽 `conversation.input.dock`）读 `todos` 投影。

实测一处会话（`session-131c0965`，XFClaw 项目的品牌链接与编辑弹窗修复）的事件序列：

| seq | 事件 | 内容 |
|---|---|---|
| 12325 | `todo/write` | 5 条：1 `in_progress` + 4 `pending` |
| 34102 | `delivery/change` | `record-design` |
| 34575 | `delivery/tasks` | 7 条：全部 `completed`（`created` 1 / `implemented` 3 / `verified` 3） |

左侧浮层显示的是 seq 34575 那份 7 条全完成的清单，右侧面板显示的是 seq 12325 那份 5 条清单——第一条一直转圈，因为此后再没有任何事件写 `todos`。

**根因是镜像的单向性。** `packages/delivery/delivery/src/tasks-fold.ts` 的 `mirrorTodos` 让 `todo/write` 镜像进 `delivery-tasks`（`l1` 限定），但 `delivery/tasks`（`record_tasks` 写入）从不反向反映到 `todos`。模型在同一任务里先后用了两个工具，两侧就各自演化、永久漂移。

这不是推送实时性缺陷。`packages/session/session-projection/src/index.ts` 对每个已提交事件驱动全部投影单元，并在 `Object.is` 判定引用变化时通知客户端；右侧卡住是因为**它读的那把投影此后再没有被写入**，不是帧没送到。

漂移方向固定：`todo_write` 先发生（模型用它做当轮计划），`record_tasks` 后发生（推进 `implemented` 前必须落清单）。所以右侧总是显示更旧的清单与更旧的状态。

## 2. 目标

- 交付任务存在时，两侧显示**同一批条目、同一组状态**。
- 没有交付任务的普通会话，输入框上方面板的既有行为完全不变（仍读 `todos`）。
- 不改变输入框上方面板的高度与紧凑形态。
- `delivery-tasks` 只描述**当前**任务：任务换代或被清理后不再返回上一份清单。

## 3. 非目标

- 不合并两个投影，不改镜像方向或 `mirrorTodos` 的 `level`/`changeId` 保护条件。
- 不改交付域的工具、门禁与推进逻辑。
- 不让输入框上方面板按阶段分组（分组形态属于左侧浮层）。
- 不改 `agent-loop`。

## 4. 现状分析

### 4.1 两个投影的写入者与生命周期

`todos`（`packages/todo/tool-todo/src/index.ts:134`）由 `todo_write` 工具写入，在 `turn/start` 时清空——它是当轮临时计划，不承载跨轮进度。

`delivery-tasks`（`packages/delivery/delivery/src/tasks-fold.ts:315`）由 `record_tasks` 工具写入 `delivery/tasks` 事件，或由 `mirrorTodos` 从 `todo/write` 镜像，跨轮持久直到任务被替换或清除。它是权威清单。

### 4.2 面板形态差异

`TodoPanel` 渲染三态图标（完成实心勾、进行中旋转环、待处理虚线环）与 `·` 连接的计数摘要，平铺列表。

`DeliveryFloatCard` 的清单按 `LEVEL_PHASES[level]` 分阶段分组，每组带 `done/total` 计数，条目带阶段归属与 `(covers: ...)` 注解。

两者共享同一份三态语义，条目内容可直接互换。

### 4.3 换代时清单不重置（既有缺陷）

`taskPosition()` 在 `create` 与 `clear` 时只更新 `level`/`phase`，从不重置 `current`。既有测试 `drops the mirror when the task is cleared` 明确断言了这一行为（清理后 `delivery-tasks` 仍返回清理前那份清单）。

两个后果：

1. 新任务创建后，投影仍返回上一个任务的清单，`changeId` 也仍是上一个任务的。左侧浮层因此拿上一份清单冒充当前任务的进度。
2. **新任务可能永久无法建立清单**：`mirrorTodos` 里的 `if (recorded !== undefined && recorded.changeId.length > 0) return state` 是"l2 的 recorded 清单不被 todo 覆盖"的保护，但残留的 `current` 让这条保护对新任务一并生效——新任务写 `todo/write` 再也不会镜像，除非它自己成功 `record_tasks`。

真实日志 `session-1eb1230a` 的形态：

| seq | 事件 |
|---|---|
| 213632 | `delivery/tasks`，11 条，`changeId='add-deterministic-plan-rendering'` |
| 218230 | `advance` → `accepted` |
| 236844 | `create` 新任务 |
| 305973 | `delivery/tasks`，13 条，`changeId='add-app-state-persistence-and-reconcile'` |

`236844` 那个任务自己从未写过 `delivery/tasks`，投影停在上一份 13 条全完成的清单上。

### 4.4 依赖方向

`packages/client/ui-delivery` 依赖 `@deepseek-ai/dsh-client-ui-conversation`（单向）。`@deepseek-ai/dsh-delivery` 不依赖任何 client 包，因此 `ui-conversation` 引入它的 client 类型出口不构成包环。`ui-conversation` 已有 `@deepseek-ai/dsh-tool-todo/client`（`skeleton/TodoPanel.tsx:8`）、`@deepseek-ai/dsh-plan-mode/client` 等同类先例。

## 5. 方案

### D1 权威选择器收敛为一处纯函数

在 `ui-conversation` 的 `skeleton/TodoPanel.tsx` 增加：

```ts
function authoritativeTodos(
  hasTask: boolean,
  checklist: DeliveryTasksView | null | undefined,
  todos: readonly TodoItem[] | null | undefined,
): readonly TodoItem[]
```

判据是**会话是否持有交付任务**（读 `delivery` 投影非 null），不是"清单是否非空"。这一点在深度自检中被证实是必须的：`mirrorTodos` 只对 `l1` 镜像，`l0` 任务的 `todo_write` 永不进入清单，`l2` 又禁用 `todo_write`，所以这两档的清单合法地为空。若按"清单非空"回落，`l0`/`l2` 会出现左侧显示「待拆分」而右侧显示当轮 todos 的不一致。

持有任务时只读清单：清单为空就返回空（左侧此时显示「待拆分」，两侧一致）；没有任务时返回 `todos`。两种空结果都指向同一个模块级 `EMPTY_TODOS` 常量，保持引用稳定——客户端 `getSnapshot` 返回行值本身，同帧引用不变，而每次渲染返回新数组会让 `useMemo` 失效（`packages/client/AGENTS.md` 反应式读取纪律第 5 条）。

选择器是纯函数，读两个投影都在渲染路径上完成，符合"派生数据是对框架钩子数据的纯函数"。

### D2 组件读两个投影，只用一个

`TodoDock` 从 `useProjection('todos')` 扩展为同时读 `useProjection('delivery-tasks')`，把两者交给 `authoritativeTodos` 后渲染。`delivery-tasks` 的 `items` 元素带 `phase` 字段，`TodoItem` 只取 `content`/`status`；转换在 `authoritativeTodos` 内完成，组件不感知阶段。

`useProjection` 的 `'delivery-tasks'` 键类型来自 `@deepseek-ai/dsh-delivery/client`，与 `TodoItem` 来自 `@deepseek-ai/dsh-tool-todo/client` 是同一类只读类型引入。依赖声明含三处：`package.json` 的 devDependency、`tsconfig.json` 的 project reference，以及 `tsconfig.base.json` 手写段的 `@deepseek-ai/dsh-delivery/types` 与 `/client` 两条别名（生成器只映射包根别名）。`dsh.client.inject` 不加条目：`delivery-tasks` 是宿主侧投影，经 `useProjection` 的键读取即可，无需加载对方的客户端插件——这与 `ui-chat` 读 `tokenUsage`、`ui-plan` 读 `plan` 的既有先例一致。

### D3 空清单与投影缺失的回退顺序

三种状态必须区分，否则会出现"有交付任务但清单为空"时面板显示左侧没有的计划：

| 有交付任务 | `delivery-tasks.items` | `todos` | 渲染 |
|---|---|---|---|
| 是 | 非空 | 任意 | 交付清单（权威） |
| 是 | 空 / 投影缺失 | 任意 | 不渲染（左侧显示「待拆分」，一致） |
| 否 | 任意 | 非空 | todos（普通会话） |
| 否 | 任意 | 空 / 缺失 | 不渲染 |

第二行覆盖 `l0`（todo 不镜像）与 `l2`（禁用 `todo_write`）两档，以及"交付任务已创建但尚未 `record_tasks`"的窗口。这些情况下交付清单确实为空，回落会让该面板显示左侧浮层没有的计划。

### D4 计数摘要跟随同一份数据

`progressLabel` 已按传入的 `todos` 计算 `done/active/pending`，无需改动；它因此自动与列表同源。这是选择器收敛带来的直接好处——摘要与列表不可能再各说一套。

### D5 换代时重置清单，并提升 `stateVersion`

`taskPosition()` 在 `create` 与 `clear` 上返回的 level/phase 之外，`applyDeliveryTasksEvent` 还在同一处把 `current` 置为 `null`：清单归属一个具体任务，任务换了它就不再是当前任务的事实。

`create` 与 `clear` 都要重置。`create` 缺失会让新任务继承旧清单，`clear` 缺失会让清理后的会话继续显示已经结束的清单。

`delivery-tasks` 的 `stateVersion` 由 `2` 提升到 `3`。它是持久化投影缓存的行失效标识（`packages/session/session-projection/src/index.ts:417` 比对 `row.ver === def.stateVersion`），fold 语义变了而版本不变会让旧缓存行继续被当作有效checkpoint。

### D6 不保留"清理后仍显示旧清单"的行为

既有测试 `drops the mirror when the task is cleared` 断言的正是本次要修掉的残留。该测试的意图是"清理后 `todo/write` 不再镜像"（这条仍然成立，因为 `level` 已置空），但它顺带固化了残留清单。改为断言清理后清单为空，同时保留"后续 `todo/write` 不镜像"这一半。

"跨任务保留上一份清单"没有任何消费者需要：`getTasks` 的五个调用点全部服务于**当前**任务的验证门禁，客户端两处面板也都只渲染当前任务的进度。

## 6. 测试

- `authoritativeTodos` 的四行真值表各一条单元测试（有任务取清单、有任务清单空、无任务取 todos、双空）。
- `TodoDock` 推送三个投影：任务存在后只渲染清单；无任务时继续渲染 todos；`l0` 形态（有任务、清单空、todos 非空）不渲染任何计划。
- 引用稳定性：无计划可显示时，不同输入形态返回同一个 `EMPTY_TODOS` 引用。
- `tasks-fold`：`create` 后清单为 `null`；`clear` 后清单为 `null`；换代后新任务的 `todo/write` 能建立自己的镜像（这一条在修复前必然失败，它正是 4.3 第二个后果）。
- 改 `drops the mirror when the task is cleared`：清理后断言清单为空，保留"后续 `todo/write` 不镜像"这一半。
- 现有 `todo-panel.client.spec.tsx` 与 `assembly-surfaces.client.spec.tsx` 的既有断言保持通过（既有测试只推 `todos` 且无 `delivery` 投影，走"无任务"分支）。
- `packages/client/ui-delivery` 侧不需要新测试：它读的投影未变。

深度自检另证明了一件事：这些断言必须在**完整装配**下成立。只挂 `SessionProjectionRegistry` 与 `ToolRuntime` 的裸 bench 里 `todos` 投影并不注册（`tool-todo` 的 `inject` 需要 `tools`、`systemPrompt` 等座位），读到 `undefined` 会让"两侧一致"变成虚假通过。跨包验证需用完整装配（本仓库的 `mountAgentLoopTestDependencies` 或等价的显式 mount）。
