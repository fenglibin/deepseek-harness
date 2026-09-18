# Agent Note: 交付分级复核范围与悬浮卡片可用性

Status: implemented

## 问题

交付悬浮卡片与它背后的分级判定存在四个可用性问题。`gradeObjective` 判成 `l1` 或 `l2` 都会自动建任务，只有判成 `l0` 才注入 `GRADING_RUBRIC` 交给模型，因此单个中等信号或两个弱关键词命中就足以对一个可能只是小修的请求施加交付纪律，用户看到的是「一输入消息就分好级」。卡片显示「设计文档 已完成」却不给出文件位置与打开入口，而同页其它文件都可点击打开。卡片常驻覆盖在转录之上，且与真实执行不一致：部分 `l1` 任务创建后直接开工，拆分走 `todo_write`，`delivery-tasks` 清单为空，卡片固定显示「待拆分」。`record_tasks` 也没有 `record_design` 那样的需求分析前置门禁。

## 决策

- **分级复核覆盖 `l0` 与 `l1`。** `autoDetect` 只在 `gradeObjective` 判 `l2` 时 `ctx.delivery.create`；判 `l0` 或 `l1` 都注入一次 `GRADING_RUBRIC`（每 turn 一次），由模型按内容决定是否建任务及其级别。程序化评分继续承担确定性拦截：强信号与超字符上限仍是自动 `l2`。
- **提示词要求非 `l2` 也先确认需求并落盘清单。** `guidance()` 与 `record_tasks` 的工具描述写明：每一级都先澄清需求、调用 `mark_analysis_done`，并用空 `change_id` 的 `record_tasks` 记录拆分；`todo_write` 只是当轮临时清单。
- **设计文档链接由 `ui-delivery` 自己持有 opener。** 插件 `inject` 增加 `remote`、`remote.session`，注册 `conversation.side.float` 时注入 `openFile`，内部调用 `ctx.remote.session.openWorkspacePath`；组件在「设计文档」组已完成时渲染指向 `designArtifact(task)` 的按钮，打开失败就地提示。路径由新增的 `designArtifact(task)` 从 `designCount` 直接推导，而不是从 `deliveryArtifacts()` 里按扩展名筛选——后者会把变更文件当成设计文档。
- **显隐偏好用 `defineStore` + `persist`。** 新增 `createDeliveryCardStore()`：`init` 为 `{ preference: 'hidden' }`，持久化键 `dsh.delivery.float-card.v2`，root 作用域，因此所有会话共享同一偏好。组件常驻挂载，在 `document` 上监听 `Ctrl+Shift+P` 并 `preventDefault` 后调 `actions.toggle()`；隐藏时返回 `null`。`shown`/`hidden` 是全部取值，`cardVisible(preference)` 只看偏好，卡片没有跟随任务的状态。键带版本后缀，因为该键曾承载过三态偏好（`auto`/`shown`/`hidden`，默认 `auto` 跟随任务），那个形状不属于当前 schema。
- **任务列表只读 `delivery-tasks` 投影。** 「任务列表」组按 `LEVEL_PHASES` 分阶段渲染该投影的条目与三态状态，并在组头标注来源。宿主 fold 把 `todo_write` 的清单镜像进这把投影，因此浮层不需要第二个数据源（[单一数据源](../bug-fix/2026-09-17-task-progress-single-source.zh.md)）。

## 备选方案

**保持只在 `l0` 注入 rubric。** 否决：单个中信号或两个弱信号就把用户拖进交付流程，误升级没有任何纠正路径。

**全部交给模型分级。** 否决：强信号（重构、协议、schema）本可确定性判定，交给模型反而引入不确定性并持续消耗 token。

**由 `conversation.side.float` 的 owner props 提供 opener。** 否决：该槽的 owner 是空对象，加 opener 等于让会话壳层为业务面提供文件打开能力，职责错位；`ui-session-changes` 已经在自己的 `inject` 里持有 opener，本插件沿用同一形状。

**隐藏状态放组件 `useState` 或写入会话日志。** 否决：前者刷新即回到默认，用户每次刷新都要重新按键；后者是纯客户端观看偏好，写日志违反 web 层纯呈现的分层。

**让卡片跟随任务自动出现（`auto` 默认）。** 否决：`auto` 在有当前任务时渲染，等于让卡片默认压回转录之上，正是本 note 要解决的遮挡问题；而卡片进度可能与用户看到的执行不一致，主动推给用户看会放大这种不一致。默认关闭、由 `Ctrl+Shift+P` 按需唤起是唯一与「覆盖在转录之上」这一形态相容的默认值，因此偏好只有 `shown`/`hidden` 两态，没有跟随态。

**合并在浮层里渲染 `delivery-tasks` 与 `todos` 两套来源。** 否决：同一任务可能两处都有，去重规则主观，反而制造新的不一致。宿主 fold 的镜像才是统一两处的机制（[单一数据源](../bug-fix/2026-09-17-task-progress-single-source.zh.md)）。

## 后果

- **获得** 分级判定在判断边界上交给模型，只有确定性的大改动才自动进入交付流程；设计文档可从卡片直接定位；进度栏默认不遮挡正文且偏好跨刷新保留；走 `todo_write` 的执行在进度栏上可见；非 `l2` 任务也有了落盘清单的指引。
- **代价** `l1` 请求每轮多一次约 100 token 的 rubric 注入，且模型可能选择不建任务——这是「按内容判断」本身的代价；`l0`/`l1` 自动建任务的旧快照与 `l1` 自动建任务的用例需随之改写；客户端新增一个 localStorage 键 `dsh.delivery.float-card.v2`。
- **延后** 需求的后续调整不会让已记录的清单自动失效，界面展示的仍是最后一次 `record_tasks` 的清单。

## Verification

`packages/delivery/tool-delivery/tests/tool-delivery.spec.ts` 的 auto-detect 组固定「中信号请求不自动建任务且注入 rubric」与「强信号仍自动建 `l2`」。`packages/client/ui-delivery/tests/delivery-float-card.client.spec.tsx` 覆盖默认隐藏（有当前任务时同样不渲染）、其它按键组合不触发、快捷键展示与隐藏往返、偏好写入 localStorage、旧键的三态值不会复活成可见卡片、卸载后不再监听、设计文档链接渲染与点击转交 opener、打开失败就地提示、清单只来自 `delivery-tasks`。`browser-plugin.client.spec.tsx` 经注册入口验证 opener 把路径原样交给 `session.openWorkspacePath`，并把它拒绝的结果变成 rejected promise。
