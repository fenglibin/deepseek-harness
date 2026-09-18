# Agent Note: 交付任务卡片撤出转录

Status: implemented

## 问题

交付纪律每次为一条消息自动建任务时，会话页面都会在消息下方插进一整块任务卡片：目标标题行、阶段链（已创建/已设计/已实现/已验证/已验收），以及可展开的时间线（创建任务、阶段推进、每条变更/设计/拆分记录）。

这块卡片是[交付纪律时间线节点与悬浮卡片](2026-09-04-delivery-timeline-and-float-card.zh.md)有意引入的转录内界面。问题出在它与用户实际要读的内容争夺位置：交付纪律是后台记账——分级、建任务、记录阶段都由工具自动完成，用户既没有请求也没有操作它——而卡片被插在每一条触发建任务的消息正下方，成为消息流里最显眼的一块。用户的要求是它「不要在页面上展示，后台执行即可，以免干扰」。

## 决定

`deliveryTaskDefinition.buildViewNode` 返回 `visibility: 'hidden'`。

节点本身完整保留：`delivery/change` 的匹配、折叠、`ChatConversationViewNode` 的构造全部照旧，Chat 快照仍持有任务的完整状态（目标、分级、阶段、三个计数、逐条事件）。变化只发生在渲染面——`orderedVisibleChatNodes` 依据该字段过滤，因此节点不进入 `order`，卡片不占用消息流。

选择 hidden 而不是注销这个 Definition，是因为 `delivery/change` 是 append-surface 事件：一旦无人匹配，`registerUnknownConversationFallback` 会把它渲染成「未知 surface 事件：delivery/change」行——比原来的卡片更糟。hidden 是保折叠、去渲染的唯一路径，也是仓库既有的「撤下该行」惯用法（`request-prompt.ts` 在条件不满足时同样以 hidden 撤行）。

`DeliveryTaskPanel`、它的 keyed 注册与它自己的 spec 都保留：卡片仍是一个可渲染的组件，只是当前没有让它进入转录的调用点。

## 替代方案

**只删掉时间线里的「创建任务」一行。** 否决：用户指的就是整块红框区域。单独摘掉一条事件仍然把标题行与阶段链留在消息流里，没有解决「干扰」。

**注销 `delivery-task` Definition。** 否决：`delivery/change` 会落到未知事件的 fallback，反而在转录里多出一行无从解释的噪声。

**在 ChatView 侧按 node kind 过滤。** 否决：可见性本就是节点自己的属性，且已有 `orderedVisibleChatNodes` 消费它。把过滤写进 ChatView 会把一个节点自己的展示决策搬到渲染层，并让该 kind 的隐藏方式与其它节点不一致。

**删掉整个 Definition 与组件。** 否决：折叠出的状态仍是有用的数据（任务分级、阶段、计数），且用户只要求不展示，没有要求失去它。

## 后果

- **获得** 消息流只剩用户与模型的对话内容。触发自动建任务的消息不再被一块后台记账卡片压住。
- **代价** 转录不再提供任务进度的可视入口。要看当前任务，用 `Ctrl+Shift+P` 唤出悬浮卡片——它读 host 投影，与本次改动无关，且本来就是「覆盖在转录之上、默认不展示」的那个界面。
- **不变** 后台逻辑一律不受影响：分级判定、建任务、阶段推进、门禁、`delivery`/`delivery-tasks` 投影、`delivery/change` 会话事件与磁盘产物全部照常工作。

## 验证

`delivery-task.client.spec.tsx` 新增「builds the node hidden so the task card stays out of the transcript」：断言节点存在、`visibility === 'hidden'`，且折叠仍跟踪到 `designed`。反向验证确认该断言有效——把实现改回 `'visible'` 时它立即失败（`expected 'visible' to be 'hidden'`）。

端到端确认过完整链路（临时探针，验证后删除）：用真实的 `ConversationNodeAssembler` + `ChatSnapshotBuilder` 喂入 create 与 advance 两条 `delivery/change`，结果为 `node.visibility === 'hidden'`、`node.data.phase === 'designed'`（折叠照常）、`built.order` 不含该节点 key（确实不渲染）。同一探针在改回 `'visible'` 时失败。
