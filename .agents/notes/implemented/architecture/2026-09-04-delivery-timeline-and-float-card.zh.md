# Agent Note: 交付纪律时间线节点与悬浮卡片

Status: implemented

## 问题

B5 的 `DeliveryDock` 把交付任务作为只读条带展示在 composer 上方的 `conversation.input.dock`。这带来两个缺陷。其一，该位置与设计 §6.6 不符：任务应作为持久卡片出现在会话时间线中，并作为悬浮卡片固定在正文左边缘，而不是 composer 的 dock。其二，dock 只展示当前快照，阶段推进后读起来仍是静态的——用户看到"已创建 → 已拆分"间隔了一个小时，因为没有按变更逐条的时间线可循。

## 决定

用两个均为只读的界面替换 `DeliveryDock`：

- 持久**时间线卡片**：一个 `ConversationNodeDefinition`（`delivery-task`）把 `delivery/change` 会话事件族折叠为一个 keyed Chat 节点。每个 `create` 打开节点，每个 `advance` / `record-*` / `clear` 更新折叠进其状态，卡片在转录中跟随任务生命周期，并在每次变更时重新渲染（实时，而非快照）。由 `DeliveryTaskPanel` 通过 `conversation.chat.node` keyed 座位渲染。
- **悬浮卡片**：`DeliveryFloatCard` 注册在新的 session 作用域 `conversation.side.float` 槽上，该槽由 `ui-conversation` 声明并渲染在正文左边缘。它读取 `delivery` 投影，折叠态展示分级徽标、阶段与目标；展开后展示阶段进度条与产物路径。

为使客户端能读取 `delivery/change` 事件数据，持久变更词汇（`DeliveryChangeMeta` 及其 `Delivery*Meta` 成员、`DeliveryOperation`、`FoldedDelivery`、`DeliveryErrorCode`）与 `SessionEventMap['delivery/change']` 合并从 host 侧 `domain.ts` 迁入 client-safe 的 `types.ts` 出口。`domain.ts` 仅保留 `DeliveryChanged` 与作用域化的 `delivery/changed` cordis 事件。

## 替代方案

**保留 dock 并另加两个界面。** 否决：用户要求替换而非叠加；同一任务三个并存的界面是噪音。

**从投影读取时间线。** 否决：`delivery` 投影是单一当前快照；时间线需要折叠 `delivery/change` 事件，而 Conversation 节点机制已增量完成此事。

**把悬浮卡片挂到 `shell.overlay`。** 否决：`shell.overlay` 是 root 作用域，其 occupant 拿不到 `useProjection`；卡片需要会话投影，因此需要一个 session 作用域槽。

## 后果

- **获得**：一个随每次交付变更实时重渲染的转录内任务卡片，加上一个针对当前任务的常驻左边缘悬浮卡片。composer dock 已移除。
- **代价**：新增 session 作用域 `conversation.side.float` 槽（声明于 `ui-conversation` 的 `slots.ts`、`apply.ts`，由 `ConversationRoot` 渲染）、一个 `ConversationNodeDefinition`，以及交付类型迁入 client-safe 出口。
- **迁移**：`delivery/change` 词汇迁入 `types.ts`；`fold.ts`、`runtime.ts`、`index.ts` 现从 `types.ts` 而非 `domain.ts` 导入。包根 re-export 未变，host 消费方不受影响。

## 验证发现

实现完成后，针对诉求——把卡片按时间放进会话、浮在左边缘、并随任务推进保持实时——对两个界面做了行为层面的复核（而非只查编译），修复了两处缺陷。

- **卡片姿态未跟随任务。** `DeliveryTaskPanel` 的展开状态只在首次挂载时从 props 取值，因此一个后来到达 `accepted` 或被 clear 的任务，会一直保持创建时的姿态。现改为派生 `settled` 标志并在跨越该边界时重新落位，并补充了 accepted 与 cleared 两条转换路径的测试。
- **卡片用错了主题标度。** 两份样式表沿用了已删除 dock 的 `--vscode-*` 自定义属性。其余客户端模块（197 个中的 195 个）都用 `--dsw-alias-*`，因此这些变量在应用主题下无定义，会回退到硬编码的浅色值——暗色模式下显示错误。两个文件现改用 `--dsw-alias-*` 颜色、`--dsw-shadow-lv2`/`lv3` 与 `--ds-font-family-code`。

另有三项行为经确认为正确，故未改动。卡片走 keyed 路径渲染——`ChatView` 把 `order` 映射为 `ChatNodeSeat`，由它按 node kind 分派到 `conversation.chat.node` 座位——因此 `legacyContribution` 中对未知 kind 返回空贡献的 `default` 分支不会把它隐藏。排序依据 `anchorSeq`，而该 Node 将其设为 create 事件的 seq。实时性成立，因为 `ChatNodeSeat` 按 key 订阅该 node，且每次 `update` 都返回新的 state 对象；新增的追加事件测试锁定了这一点，因为此前的测试只覆盖了一次性回放。

仍有两个缺口，记录在包的 README 中而本次未修：产物*内容*预览需要 host 把 `fs` 读取投影到客户端；门禁通过/失败与后置命令结果没有可回放的 durable 事件，因而无法作为时间线条目。
