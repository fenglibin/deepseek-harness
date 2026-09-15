## Context

程序化评分 `gradeObjective` 已经是三档决策（字符上限 → 强信号 → 中/弱信号），它承担的是确定性拦截。本次要改的是「拦截之外的部分由谁判断」。悬浮卡片的文件打开能力与显隐偏好则需要在客户端选一个既有的承载机制，避免为单个卡片新增框架扩展点。详细现状分析与方案对比见 `docs/design/delivery-float-card-usability-rationale.zh.md`。

## Goals / Non-Goals

**Goals**：分级贴合内容；设计文档可点击定位；进度栏按需唤起且偏好跨刷新保留；走 `todo_write` 的执行在进度栏上可见。

**Non-Goals**：不改交付任务执行逻辑、门禁与时间线卡片；不改 `agent-loop`；不解决「需求中途调整导致已记录清单过期」；不做跨设备同步；不引入全局键盘服务。

## Decisions

### D1 分级复核的触发范围：只有强信号或超长才自动建任务

`autoDetect` 钩子改为 `gradeObjective` 判 `l2` 时直接 `ctx.delivery.create`，判 `l0` 或 `l1` 时注入 `GRADING_RUBRIC`（每 turn 一次），由模型决定是否建任务与建哪级。`GRADING_RUBRIC` 文案相应改写：说明自动评分未判定为 `l2`，给出 `l1` 与 `l2` 的判据，并明确「不值得上流程就不建任务」。

放弃的方案：保持只在 `l0` 注入（单个中信号或两个弱信号就把用户拖进交付流程，误升级无法纠正）；全部交模型（强信号本可确定性判定，交给模型反而引入不确定性）。

### D2 设计文档链接由 ui-delivery 自己持有 opener

`ui-delivery` 的 `inject` 增加 `remote`、`remote.session`，在注册 `conversation.side.float` 的 `inject` 里返回 `openFile: (path) => ctx.remote.session.openWorkspacePath({ path })`，失败时抛出 `result.error.message`。组件在「设计文档」组状态为 `done` 时，取 `deliveryArtifacts(task)` 中的 `.md` 路径渲染一个按钮，点击调 `openFile`，rejected 时在组件内显示错误文本。

放弃的方案：经 `conversation.side.float` 的 owner props 传入 opener——该槽的 owner 是空对象，加 opener 等于让会话壳层为业务面提供文件打开能力，职责错位。

### D3 显隐偏好用 defineStore + persist，快捷键监听挂在卡片上

新增 `createDeliveryCardStore()`：`defineStore`，`init: () => ({ visible: false })`，`actions: { toggle }`，`persist: 'dsh.delivery.float-card'`，root 作用域（不带 scope key），因此所有会话共享同一偏好。注册时声明 `store` 座位，组件经 `useStore` 读、经 `actions.toggle()` 写。

快捷键监听放在卡片组件内：卡片常驻挂载，隐藏时返回 `null`；`useEffect` 在 `document` 上监听 `keydown`，匹配 `ctrlKey && shiftKey` 且 `key` 大小写不敏感等于 `p` 时 `preventDefault()` 并 `toggle()`。这样无需新增全局键盘服务，插件卸载即随 fiber 释放监听。

放弃的方案：组件内 `useState`（刷新即回到默认，用户每次刷新都要重新按键）；写入会话日志（展示偏好是纯客户端观看状态，写日志违反 web 层纯呈现的分层）。

### D4 任务列表在交付清单为空时回落到 todos

卡片增加 `useProjection('todos')`；`delivery-tasks` 的 `items` 为空且 `todos` 非空时，任务列表组渲染 `todos` 的 `content`/`status`，并在组标签旁标注来源。两套来源不混排：交付清单非空时 `todos` 完全不参与渲染。

放弃的方案：合并两套来源（同一任务可能两处都有，去重规则主观，反而制造新的不一致）。

## Risks / Trade-offs

- `l1` 请求多一次 rubric 注入（约 100 token/轮），且模型可能选择不建任务。这是诉求本身要的「按内容判断」，可接受。
- 模型可能忽略 rubric 而不建任务，此时 `l1` 请求不再有交付流程。程序化评分仍在强信号与超长时兜底。
- 隐藏后用户可能不知道卡片存在。快捷键是唯一入口，需要在 README 与卡片无障碍标签上说明。
- `todos` 在 `turn/start` 清空，回落展示会随轮次消失；这是 `todo_write` 本身的语义，不做补偿。

## Migration Plan

无磁盘格式与协议变化。新增一个 localStorage 键 `dsh.delivery.float-card`；旧客户端读到不存在时按默认隐藏处理。

## Open Questions

无。
