# Agent Note：交付纪律客户端 UI

Status: implemented

## 问题

B1–B4 交付了任务领域、工具、门禁、产物持久化与后置命令，但 Web GUI 没有呈现其中任何内容：用户看不到当前交付任务的分级、阶段或产物清单，因此设计文档「让每个阶段可见」的目标（§2、§6.6）未达成。

## 决策

新增一个只读的 `@deepseek-ai/dsh-client-ui-delivery` 界面插件，其 `DeliveryDock` 注册在 `conversation.input.dock` 条带上，并通过会话标准 `useProjection` 座位读取 host 计算的 `delivery` 投影。

- 条带展示规模分级（`L0`/`L1`/`L2`）、生命周期阶段、截断的目标，以及一个产物计数，其 tooltip 列出由快照的 `changeCount`/`designCount`/`specCount` 推导出的精确路径（`.dsh/changes/<id>.md`、`.dsh/design/<id>.md`、`openspec/changes/<id>/spec.md`）。
- 加载中（`undefined`）与无当前任务（`null`）不渲染，且没有变更动词——任务通过模型侧工具推进，因此界面不拥有 store、也不发出事件。Web 预设把它挂在 `ui-goal` 之后。

这是[交付纪律设计](../../../../docs/design/delivery-discipline-rationale.zh.md)的 B5 批次：投影支撑的客户端 UI。`delivery` 会话投影本身在 B1 已交付。

## 备选方案

**在会话时间线内展示任务。** 否决：设计的 §6.6 侧边栏/卡片与产物预览是持久的 dock 关注点，而 input-dock 条带是 goal/session-changes 界面的既定座位。

**给条带加 accept/clear/advance 动词。** 否决：变更属于模型侧工具；只读界面避免在客户端重复 CAS 逻辑。

**为产物清单引入 `delivery/artifact-written` 事件。** 本批次否决：record 工具写入确定性路径，因此清单由记录计数推导；该事件推迟到模型能写入任意 `openspec/` 文件时。

## 后果

- **获得** 可见的交付界面：分级徽标、覆盖其分级所要求阶段的进度条、未满足时的下一门禁前置条件，以及产物路径（20 条 jsdom 测试，100% 覆盖率）。
- **代价** 一个新的客户端包（语言字典、dock 注册、tsconfig/base/client + bundle 接线），以及 `useProjection` 消费的 `delivery` 投影 key。
- **延期（不变）** `delivery/artifact-written` 会话事件投影、实时产物内容预览面板、阶段转换/门禁通过失败/后置命令结果的会话时间线节点（其回放需要先把门禁与后置命令结果做成 durable 事件），以及配置设置卡片。
