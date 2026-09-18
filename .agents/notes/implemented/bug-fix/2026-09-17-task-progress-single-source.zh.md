# Agent Note: 会话页两处任务进度统一到单一数据源

Status: implemented

## Problem

会话页同时渲染两个任务进度面板，它们对同一个任务给出互相矛盾的清单与状态：

- 左侧交付浮层（`DeliveryFloatCard`，槽 `conversation.side.float`）读 `delivery-tasks` 投影，即 `record_tasks` 写入的权威清单。
- 输入框上方面板（`TodoPanel`，槽 `conversation.input.dock`）只读 `todos` 投影，即 `todo_write` 写入的当轮清单。

两个投影由不同工具写入、生命周期也不同（`todos` 在每个 `turn/start` 清空，`delivery-tasks` 跨轮持久）。真实会话 `session-131c0965`（XFClaw 品牌链接与编辑弹窗修复）的事件序列是典型形态：

| seq | 事件 | 内容 |
|---|---|---|
| 12325 | `todo/write` | 5 条：1 `in_progress` + 4 `pending` |
| 34575 | `delivery/tasks` | 7 条：全部 `completed` |

左侧读 seq 34575 那份 7 条全完成清单，右侧读 seq 12325 那份 5 条清单——第一条一直显示"进行中"转圈，因为此后再也没有事件写过 `todos`。漂移方向固定：`todo_write` 总先于 `record_tasks`（后者是推进 `implemented` 的前置门禁），所以右侧始终显示更旧的计划。

这不是推送实时性缺陷。`session-projection` 对每个已提交事件驱动全部投影单元，并在 `Object.is` 判定引用变化时通知客户端；右侧停住是因为**它读的那把投影此后再没有被写入**。

排查过程中另发现一处更严重的既有缺陷，它决定"统一数据源"能否真正生效：`tasks-fold.ts` 的 `taskPosition()` 在 `create` 与 `clear` 上只更新 `level`/`phase`，从不重置 `current`，因此新任务继承上一个任务的清单。后果有二：

1. 投影返回旧任务的清单，`changeId` 也仍是旧任务的，左侧浮层拿上一份清单冒充当前任务的进度。
2. `mirrorTodos` 里的 `if (recorded.changeId.length > 0) return state` 本意是"l2 的 recorded 清单不被 todo 覆盖"，残留的 `current` 让这条保护对新任务一并生效——上一任务若用非空 `changeId` 记录过清单，新任务的 `todo_write` 永久不再镜像。

真实会话 `session-1eb1230a` 佐证：`seq=213632` 记录 `changeId='add-deterministic-plan-rendering'`，`seq=218230` 推进到 `accepted`，`seq=236844` 创建新任务，而该新任务自己从未写过 `delivery/tasks`，投影停在上一份 13 条全完成的清单上。

## Decision

**客户端面板改为按任务归属取投影。** `ui-conversation` 的 `TodoPanel.tsx` 新增纯函数 `authoritativeTodos(hasTask, checklist, todos)`：会话持有交付任务（`delivery` 投影非 null）时只读 `delivery-tasks`，否则读 `todos`。`TodoDock` 同时读三把投影，经 `useMemo` 派生后渲染；面板的形态（平铺三态列表与计数摘要）不变，`progressLabel` 沿用同一份数据，因此摘要与列表不可能再各说一套。

判据是任务归属而非"清单非空"，这一点由深度自检确立。最初按"清单非空才用交付清单"实现，完整装配下的探针立刻显示 `l0` 与 `l2` 两侧仍不一致：`mirrorTodos` 只对 `l1` 镜像，`l0` 的 `todo_write` 永不进入清单，`l2` 又禁用 `todo_write`，因此这两档清单合法地为空，而旧判据会回落显示左侧浮层没有的当轮计划。持有任务时清单为空就渲染空列表——左侧此时显示「待拆分」，两侧一致。

没有任务的回落分支不是防御性冗余：普通会话（没有交付任务）只有 `todos`，未装交付域的部署也走这一支。两种空结果都返回模块级 `EMPTY_TODOS`，保持引用稳定——客户端投影 face 的 `getSnapshot` 返回行值本身，同帧引用不变。

**换代时退役清单。** `tasks-fold.ts` 的 `applyDeliveryTasksEvent` 在 `create` 与 `clear` 上把 `current` 置为 `null`（`retiresChecklist` 判定，且仅在 `current` 非空时重建状态对象，以保留未变化即同引用的保证）。`delivery-tasks` 的 `stateVersion` 由 `2` 提升到 `3`：它是持久化投影缓存行的失效标识，fold 语义变了而版本不变会让旧缓存行继续被当作有效 checkpoint。

## Alternatives considered

**让 `todos` 反向镜像 `delivery/tasks`，在宿主侧统一。** 否决：`todos` 属于 `tool-todo` 自己的域，让交付域反向写它会把两个域焊死；新增第三个投影键则改动面与长期维护成本都更大，而客户端一个纯选择器就够。

**输入框上方面板只读 `delivery-tasks`，没有交付任务时不渲染。** 否决：普通会话会彻底失去输入框上方的任务清单，是明显的功能回归。

**按"交付清单非空"决定是否回落 `todos`。** 否决：自检实证该判据在 `l0` 与 `l2` 上失效——这两档的清单合法地为空，回落会让面板显示左侧浮层没有的当轮计划。判据必须是任务归属。

**右侧也按阶段分组，与浮层逐字对齐。** 否决：交付清单条目带 `phase` 与 `(covers: ...)` 注解，分组会把输入框上方的面板从紧凑平铺变成 3 组 7 行，挤压正文；两处共享的是数据与状态，不是排版。

**保留"清理后仍显示旧清单"的行为。** 否决：该行为只被测试固化，没有消费者需要——`getTasks` 的五个调用点全部服务于**当前**任务的验证门禁，客户端两处面板也只渲染当前任务进度。

**在客户端用任务 id 过滤陈旧清单，不动宿主域。** 否决：那只让显示正确，`getTasks` 仍会把上一个任务的清单交给 `checklistGap`、`checklistMismatch`、`coverageGap` 与 `verificationCommandFailure` 四个门禁，缺陷留在权威侧。

## Consequences

- **获得** 交付任务存在时，两处面板显示同一批条目与同一组状态；`delivery-tasks` 只描述当前任务，不再跨任务残留；换代后新任务能正常建立自己的镜像清单。
- **代价** `ui-conversation` 新增 `@deepseek-ai/dsh-delivery` 依赖（devDependency + `tsconfig.json` project reference），并需要在 `tsconfig.base.json` 手写段补 `@deepseek-ai/dsh-delivery/types` 与 `/client` 两条别名——生成器只映射包根别名，子路径别名历来手写。`delivery-tasks` 的 `stateVersion` 提升使既有投影缓存行失效，首次读取退回全量重放一次。
- **验证** `packages/delivery`、`packages/todo`、`packages/client` 受影响面与 `packages/api/session-controller` 共 115 个文件 1621 条全绿；两个编译面 `tsc -b` 通过。`drops the mirror when the task is cleared` 改为断言清理后清单为空并保留"后续 `todo_write` 不镜像"，另加两条：换代退役前一份清单、上一任务带非空 `changeId` 记录后新任务仍能镜像（后者在修复前必然失败）。客户端选择器测试覆盖四行真值表，`TodoDock` 覆盖三种投影组合。用真实事件序列重放三个投影，确认 `l1` 两侧条目与状态逐字相同、`l0` 与 `l2` 两侧同为无计划，且换代后新任务清单为 `null` 并能建立自己的镜像。

自检同时记录了一个方法论要点：这些断言必须在**完整装配**下运行。只挂 `SessionProjectionRegistry` 与 `ToolRuntime` 的裸 bench 里 `todos` 投影并不注册（`tool-todo` 的 `inject` 需要 `tools`、`systemPrompt` 等座位），读到 `undefined` 会让"两侧一致"虚假通过——最初的探针正是这样漏掉了 `l0`/`l2` 的不一致。
