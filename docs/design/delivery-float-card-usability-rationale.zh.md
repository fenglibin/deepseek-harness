# 交付进度栏可用性优化方案

> 状态：决策已对齐，待实施
> 目标读者：维护者与决策者
> 关联诉求：让分级判定在长度之外真正交给模型复核、让「设计文档」进度可点击定位、让左侧进度栏默认隐藏并按需唤起，并缩小进度栏与实际执行的不一致。
> 关联文档：[交付纪律方案](delivery-discipline-rationale.zh.md)、[自动触发方案](delivery-discipline-auto-trigger-rationale.zh.md)、[需求分析与进度呈现方案](delivery-discipline-analysis-progress-rationale.zh.md)

---

## 1. 背景与动机

会话页左侧的交付悬浮卡片（`DeliveryFloatCard`）与它背后的分级判定当前存在四个可用性问题：

1. **分级判定对用户不可见，且只在一种情况下交给模型。** 程序化评分 `gradeObjective` 先按字符长度分档，再扫关键词信号；只有判成 `l0` 时才注入 `GRADING_RUBRIC` 让模型复核。判成 `l1` 时直接创建任务，用户看到的是「一输入消息就分好级了」，无法判断这个级别是长度拍的还是真按内容判的。
2. **「设计文档」进度不可点击。** 卡片显示「已完成」，但不告诉用户文件在哪，也不提供打开入口；同一页面的其它文件（产物行、变更停靠栏）都可点击打开。
3. **进度栏常驻且会与实际执行不一致。** 卡片固定在正文左上角，遮挡正文；更关键的是，部分 `l1` 任务被创建后直接开工，没有需求确认与拆分流程，拆分实际走 `todo_write` 而 `delivery-tasks` 清单为空，卡片固定显示「待拆分」，与用户看到的实际进展不符。需求中途调整时，已记录的清单也不会随之改变。
4. **`l1` 的流程约束弱于 `l2`。** `record_design` 有 `mark_analysis_done` 前置门禁，但 `record_tasks` 没有；模型可以完全不落盘清单就推进任务。

## 2. 目标

- 分级判定在程序化评分给出 `l0` **或** `l1` 时都交给模型复核，让「是否值得上交付流程」由模型按内容判断，而非由字符数与关键词决定。
- 「设计文档」组在已完成状态下渲染一个可点击的文件链接，打开行为与会话内其它文件一致。
- 悬浮卡片默认不展示；`Ctrl+Shift+P` 切换展示与隐藏，选择跨刷新持久化。
- 任务列表组在交付清单为空时回落到 `todos` 投影，让走 `todo_write` 的执行也体现在进度栏上。
- 提示词要求 `l1` 也必须先完成需求确认并落盘任务清单。

## 3. 非目标

- 不移除、不重构交付任务的执行逻辑与门禁；隐藏只是不展示，`delivery`/`delivery-tasks` 投影、时间线卡片、工具与门禁全部保持现状。
- 不改 `agent-loop`。
- 不解决「需求中途调整导致已记录清单过期」——清单的权威更新仍由模型通过 `record_tasks` 完成；本次只保证「实际用了 `todo_write` 的执行不再被显示成待拆分」。
- 不为隐藏状态引入服务端持久化或跨设备同步。

## 4. 现状分析

### 4.1 分级判定

`packages/delivery/tool-delivery/src/grading.ts` 的 `gradeObjective` 是三档决策：`objective.length > specChars`（默认 200）直接 `l2`；否则扫强/中/弱三档信号（编号列表 ≥ 3 项算一个强信号）；强信号 → `l2`，中信号 ≥ 2 → `l2`，中信号 = 1 或弱信号 ≥ 2 → `l1`；都没命中 → `l0`。

`packages/delivery/tool-delivery/src/index.ts` 的 `autoDetect` 钩子在 `agent/pre-step` 里对直接人类消息调用它：判成 `l1`/`l2` 就 `ctx.delivery.create`；判成 `l0` 才注入一次 `GRADING_RUBRIC`。所以「LLM 复核」当前只覆盖 `l0` 一侧。

### 4.2 设计文档路径

设计记录写在 `.dsh/design/<task-id>.md`（`record_design`），task id 即投影快照的 `id`；`deliveryArtifacts()` 已经从 `designCount > 0` 推导出这个路径，但只被导出，悬浮卡片并未使用。

### 4.3 悬浮卡片与槽位

卡片注册在 session 作用域的 `conversation.side.float` 槽（`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx` 在 `.body` 内渲染），用 `position: absolute` 固定左上角。它读 `useProjection('delivery')` 与 `useProjection('delivery-tasks')`，插件自身不拥有 durable 状态。

### 4.4 文件打开能力

`ctx.remote.session.openWorkspacePath({ path })` 是 host 侧唯一的文件打开入口；`ui-chat`、`ui-session-changes`、`ui-deliverables` 各自在自己的 `inject` 里把它包成 `openFile(path)`。它接受 workspace 相对路径，因此 `.dsh/design/<id>.md` 可以直接传。

### 4.5 清单来源

`delivery-tasks` 投影由 `record_tasks` 写入；`todos` 投影由 `todo_write` 写入，在 `turn/start` 清空。两者当前互不相干，而 `l1` 任务的实际拆分往往只走了后者。

## 5. 方案对比与选型

### D1 分级复核的触发范围

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 仅 `l0` 注入 rubric（现状） | 程序化评分判 `l1`/`l2` 即建任务 | 简单，但单个中信号或两个弱信号就把用户拖进交付流程，误升级无法纠正 |
| B. `l0` 与 `l1` 都交模型复核（选定） | 只有强信号或超长才自动建任务；`l0`/`l1` 都注入 rubric，由模型决定建不建、建哪级 | 分级贴合内容；每轮多一次 rubric 注入（约 100 token），且模型可能不建任务——可接受，因为用户要的正是「按内容判断」 |
| C. 全部交模型 | 取消程序化评分 | 强信号（重构、协议、schema）本可确定性判定，交给模型反而引入不确定性 |

选定 B。程序化评分继续承担「确定性拦截」：命中强信号或超过字符上限时直接 `l2`，不消耗模型判断。

### D2 「设计文档」链接的承载方式

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 悬浮卡片自己接 `ctx.remote.session.openWorkspacePath`（选定） | 插件在 `apply` 里构造 `openFile`，经 `inject` 交给组件 | 与 `ui-session-changes` 的现有做法一致；`ui-delivery` 需要新增 `remote`/`remote.session` 依赖声明 |
| B. 经 `conversation.side.float` 的 owner props 传入 | 由 ui-conversation 提供 opener | `conversation.side.float` 的 owner 是空对象，加 opener 等于让会话壳层为业务面提供文件打开能力，职责错位 |
| C. 只显示路径文本，不可点击 | 零依赖 | 不满足诉求 |

选定 A。打开失败沿用 `ui-session-changes` 的契约：`openFile` 返回 rejected promise，由组件就地提示，不弹对话框。

### D3 隐藏状态与快捷键

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 组件内 `useState` | 刷新即回到默认 | 用户每次刷新都要重新按快捷键，不符合「按需唤起」的直觉 |
| B. `defineStore` + `persist`（选定） | 注册时声明 store 座位，`init` 为隐藏，`persist` 写入 localStorage | 复用客户端既有持久化机制（`@deepseek-ai/dsh-client-store`），随刷新与重开保留；`defineStore` 是注册座位的既有货币 |
| C. 写进会话日志 | 跨设备一致 | 展示偏好是纯客户端观看状态，写日志违反「web 层是纯呈现」的分层 |

选定 B。store 用 root 作用域（`persist` 不带 scope key），因此所有会话共享同一偏好——诉求是「这个进度栏默认不展示」，是全局观看偏好而非按会话。

快捷键监听挂在卡片组件上：卡片常驻挂载（隐藏时渲染 `null`），`document` 上监听 `keydown`，匹配 `ctrlKey && shiftKey && key === 'P'`（大小写不敏感），`preventDefault` 后切换 store。这样无需新增全局键盘服务，且插件卸载即随 fiber 释放监听。

### D4 任务列表回落

| 方案 | 描述 | 取舍 |
|---|---|---|
| A. 清单为空时读 `todos` 投影（选定） | 卡片在 `delivery-tasks` 无条目时显示 `todos` 的项与状态 | 让 `todo_write` 的执行可见；两套来源不混排，避免同一件事出现两次 |
| B. 合并两套来源 | 清单与 todos 并集展示 | 同一任务可能两处都有，去重规则主观，反而制造新的不一致 |
| C. 不改 | 固定显示「待拆分」 | 就是当前被抱怨的现象 |

选定 A。回落只发生在交付清单为空时，且 `l1`/`l2` 仍以交付清单为权威；`todos` 只是「模型实际在做的事」的可见化。

## 6. 详细设计

### 6.1 分级复核（`packages/delivery/tool-delivery/src/index.ts`）

`autoDetect` 钩子改为：`gradeObjective` 判 `l2` → 直接 `ctx.delivery.create`；判 `l0` 或 `l1` → 注入 `GRADING_RUBRIC`（每 turn 一次）。`GRADING_RUBRIC` 文案相应改为说明「自动评分没有判定为 l2」，并明确 `l1` 的判据与「不值得上流程就不建任务」。

### 6.2 设计文档链接（`packages/client/ui-delivery`）

- `index.ts`：`inject` 增加 `remote`、`remote.session`；注册 `conversation.side.float` 时经 `inject` 返回 `openFile: (path) => ctx.remote.session.openWorkspacePath({ path })`，失败时抛出 `result.error.message`。
- `DeliveryFloatCard.tsx`：`design` 组状态为 `done` 时，在状态文本后渲染一个 `<button>`，标签取自 `deliveryArtifacts(task).find(path => path.endsWith('.md'))`，`onClick` 调 `openFile(path)`，失败就地显示错误文本（组件内 state）。
- `package.json`：`dsh.client.inject` 增加 `@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-api-session-controller`。
- `locales.ts`：新增 `progress.design.open`（打开按钮的 aria-label，带 `{path}`）与 `progress.design.openFailed`。

### 6.3 隐藏与快捷键（`packages/client/ui-delivery`）

- 新增 `packages/client/ui-delivery/src/client/visibility-store.ts`：`createDeliveryCardStore()` 用 `defineStore`，`init: () => ({ visible: false })`，`actions: { toggle: d => { d.visible = !d.visible } }`，`persist: 'dsh.delivery.float-card'`。
- `index.ts`：`apply` 内创建一次 handle，注册时声明 `store`；`inject` 里不需要额外参数（`visible` 由组件经 `useStore` 读）。
- `DeliveryFloatCard.tsx`：`props.useStore` 读 `visible`，`props.actions.toggle()` 写；`useEffect` 在 `document` 上监听 `keydown`，匹配 `Ctrl+Shift+P` 时 `preventDefault()` 并 `toggle()`；`visible === false` 时返回 `null`（保留组件挂载以维持监听）。

### 6.4 任务列表回落（`packages/client/ui-delivery`）

`DeliveryFloatCard.tsx` 增加 `useProjection('todos')`；`delivery-tasks` 的 `items` 为空且 `todos` 非空时，任务列表组渲染 `todos` 的 `content`/`status`，并在组标签旁标注来源。`package.json` 增加 `@deepseek-ai/dsh-tool-todo` 依赖以取 `TodoItem` 类型。

### 6.5 提示词（`packages/delivery/tool-delivery/src/index.ts`）

`guidance()` 与 `record_tasks` 的 description 补充：非 `l2` 任务同样必须先与用户确认需求、调用 `mark_analysis_done`，并用 `record_tasks`（空 `change_id`）落盘清单，`todo_write` 只作当轮临时清单。

## 7. 影响面

| 面 | 影响 |
|---|---|
| 模型可见 | `guidance()` 与 `GRADING_RUBRIC` 文案变化；`l0`/`l1` 请求会收到 rubric 注入（`l1` 是新增的注入面）。`snapshots/session/*` 与 `snapshots/sdk/*` 的 `system-prompt.expected.md` 需刷新。 |
| 用户可见 | 悬浮卡片默认隐藏；`Ctrl+Shift+P` 唤起；设计文档可点击；任务列表在清单为空时显示实际 todo。 |
| 持久化 | 新增一个 localStorage 键 `dsh.delivery.float-card`；无 session 日志或磁盘格式变化。 |
| 兼容 | 无 `SESSION_FORMAT_VERSION` 变化；`GRADING_RUBRIC` 文案不构成协议。 |

## 8. 验证策略

- 单测：`tool-delivery` 的 `auto-detect` 用例改为「`l1` 请求注入 rubric 且不自动建任务」；新增「强信号仍自动建 `l2`」。
- 客户端单测：`delivery-float-card.client.spec.tsx` 覆盖默认隐藏、快捷键切换、持久化读写、设计文档链接点击与打开失败提示、清单为空时回落 `todos`。
- 快照：刷新 `snapshots/session/text-turn`、`snapshots/sdk/text-turn` 等含 `system-prompt.expected.md` 的场景。
- 文档：更新 `packages/client/ui-delivery/README.zh.md`、`packages/delivery/tool-delivery/README.zh.md`。
