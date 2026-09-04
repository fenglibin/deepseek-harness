# Agent Note：交付纪律设计分级

Status: implemented

[English](2026-09-03-delivery-discipline-design-tiering.md) | 中文

## 问题

B1 为会话提供了一个持久的、可追溯变更的任务，并带有只进不退的阶段顺序，但每个任务默认从 `l0` 开始，而 `designed` 阶段（存在于 `l1`/`l2` 顺序中）无法到达：没有任何东西记录设计，也没有任何东西要求设计。一个本应携带设计的任务与小微修复无法区分，也没有规模信号来自动选择分级。

## 决策

扩展交付领域与工具，使任务能够携带设计记录，并且其规模分级由配置的 proxy 选择，而非仅由显式 `level` 选择。

- `@deepseek-ai/dsh-delivery` 新增 `DeliverySnapshot.designCount`、`delivery/change`（版本 1）上的 `record-design` 操作，以及 `ctx.delivery.recordDesign(agent, ref, text)`。严格 fold 像解码 `record-change` 一样解码并应用 `record-design`：它要求当前任务、精确的下一个 revision、递增 1 的 `designCount` 与不回退的时间戳。`advance` 与 `create` 现在也守护 `designCount`（create 要求为零；advance 要求保持不变）。
- `@deepseek-ai/dsh-tool-delivery` 新增 `record_design` 工具与 `designThreshold.descriptionChars` 配置（默认 `300`）。`create_delivery_task` 在未提供 `level` 且目标长度达到阈值时推断为 `l1`，否则为 `l0`；显式 `level` 仍然覆盖。`advance` 门禁现在要求到达 `designed` 之前至少存在一条设计记录，与 `implemented` 之前的既有变更记录门禁对称。

这是[交付纪律设计](../../../../docs/design/delivery-discipline-rationale.zh.md)的 B2 批次：设计文档工具、规模分级与 `designThreshold` 门禁。`todoCount`/`touchedFiles` 规模 proxy（需要 todo/fs 集成）与 openspec 拆分是后续批次。

## 备选方案

**复用 `record_change` 操作来记录设计。** 否决：设计与代码变更是带不同门禁的不同事实；重载同一个操作会迫使调用方把区分编码进文本并复杂化 fold。

**用一个固定阈值且无配置来推断分级。** 否决：阈值随部署而异（token 充裕 vs 匮乏的用户），因此它必须是经过校验的 `Config` 字段，而不是常量。

**始终让模型显式选择 `level`。** 否决：模型默认走最省力路径，因此自动 proxy 加手动覆盖才是真正产生正确分级而不引发提示疲劳的方式。

## 后果

- **获得** 设计记录与 `designed` 门禁，使较大任务现在被迫编写设计，并且任务分级由可配置的规模 proxy 加显式覆盖来选择。
- **代价** 新的 `record-design` 操作与 `designCount` 字段贯穿 fold、投影及每个工具结果；`designThreshold` 增加一个需在 `apply` 时校验的配置字段。
- **延期** `todoCount`/`touchedFiles` proxy（需要 todo/fs 工具集成）、`.dsh/design/` 文件系统产物与 openspec 拆分（B3）；设计记录目前仍仅以 durable 事件存在。
