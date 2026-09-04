# Agent Note: 交付纪律任务能力

Status: implemented

[English](2026-09-03-delivery-discipline-task-capability.md) | 中文

## 问题

harness 中的 agent 自由执行任务：它可以直接改代码并声称完成，却不产生任何变更记录、设计或任务拆分，也没有任何程序化手段阻止它跳过必需阶段。纯 prompt 约束（"请自检"）不可靠，因为模型可以口头应承而不实际执行。结果是工作不可追溯、不可验证、不可控，也没有可配置的强度来适配 token 充裕与匮乏的不同用户。

## 决定

以两个包——一个服务及其模型侧工具——交付 `delivery` capability，为会话提供一个持久化、可追溯变更的任务，并带前向唯一的阶段顺序。

- `@deepseek-ai/dsh-delivery`（`packages/delivery/delivery/`）以事件溯源服务承载 `DeliveryTask` 领域。`ctx.delivery` 支持 `create`、`advance`、`recordChange`、`clear`，使用 compare-and-set 的 `{ id, revision }` 引用，追加 `delivery/change`（version 1）会话事件，并注册严格的 `delivery` 会话投影单元与 invariant companion。fold 拒绝畸形结构、不连续 revision、跳过阶段、时间戳回退与 id 复用。
- `@deepseek-ai/dsh-tool-delivery`（`packages/delivery/tool-delivery/`）注册 `get_delivery_task`、`create_delivery_task`、`record_change`、`advance_delivery_task`。其 `enforcement` 配置选择门禁：`stateful`（默认）在至少有 1 条变更记录前阻止推进到 `implemented`，`advisory` 只提醒不阻止，`off`（或 `enabled: false`）不注册工具。
- 任务携带规模分级——`l0`（`created → implemented → verified → accepted`）、`l1`（增加 `designed`）、`l2`（增加 `specified`）——阶段顺序由领域层强制，而非工具层。
- 该 capability 挂载在 base bundle 中 `goal` 旁，`enforcement: stateful`。

这是[交付纪律设计](../../../../docs/design/delivery-discipline-rationale.zh.md)的 B1 批次：任务领域、阶段状态机、以 durable 事件承载的变更记录、以及可配置门禁。落到 `.dsh/changes/` 的产物持久化、`design` 阶段门禁、以及 openspec 拆分是后续批次。

## 替代方案

**复用 `goal` 作为任务载体。** 否决：`goal` 是单一长期目标，带基于轮次的续跑与自己的阶段词汇；delivery 需要不同的阶段顺序与变更计数事实，强塞进 goal 会扭曲两个领域。

**组合 `plan-mode` + `tool-todo` + `workflow` 加一层薄门禁。** 否决：`tool-todo` 是整表替换（不适合 openspec 拆分），`plan-mode` 是 guidance 而非 enforcement；在其上的门禁会背负它们的语义错配。

**先只做最小变更记录层。** 否决：没有领域模型与状态机，后续 design 与 openspec 批次需要重写。

## 后果

- **获得**：一个持久化、严格重放的任务状态机 + 可配置门禁强度，是首个对抗模型漂移的程序化强制点。
- **代价**：新增事件类型（`delivery/change`）与投影键，以及一个与 harness 偏 guidance 姿态并行的新 enforcement 范式——可接受，因为门禁只阻止推进到 `implemented`，从不阻止探索性工具使用。
- **延后**：产物持久化（`.dsh/changes/` 文件）、`design` 阶段门禁（B2）、openspec 拆分（B3）；变更记录目前仅以 durable 事件存在。
