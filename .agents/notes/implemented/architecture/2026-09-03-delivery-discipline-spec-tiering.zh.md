# Agent Note：交付纪律 spec 分级

Status: implemented

[English](2026-09-03-delivery-discipline-spec-tiering.md) | 中文

## 问题

B1 与 B2 为会话提供了带设计记录与 `designed` 门禁的可追溯变更任务，但 `specified` 阶段（存在于 `l2` 顺序中）仍无法到达：没有任何东西记录 spec，也没有任何东西要求 spec，且 `l2` 分级没有自动的规模信号。

## 决策

扩展交付领域与工具，使 `l2` 任务能够携带 spec 记录，并且其规模分级可以通过第二个配置 proxy 自动分级到 `l2`。

- `@deepseek-ai/dsh-delivery` 新增 `DeliverySnapshot.specCount`、`delivery/change`（版本 1）上的 `record-spec` 操作，以及 `ctx.delivery.recordSpec(agent, ref, text)`。严格 fold 完全像解码 `record-change`/`record-design` 一样解码并应用 `record-spec`：它要求当前任务、精确的下一个 revision、递增 1 的 `specCount` 与不回退的时间戳。`create` 与 `advance` 现在也守护 `specCount`（create 要求为零；advance 要求保持不变）。
- `@deepseek-ai/dsh-tool-delivery` 新增 `record_spec` 工具与 `openspecThreshold.descriptionChars` 配置（默认 `1200`）。`create_delivery_task` 在未提供 `level` 且目标长度达到该阈值时推断为 `l2`，在设计阈值处为 `l1`，否则为 `l0`；显式 `level` 仍然覆盖。`advance` 门禁现在要求到达 `specified` 之前至少存在一条 spec 记录，与变更、设计记录门禁对称。

这是[交付纪律设计](../../../../docs/design/delivery-discipline-rationale.zh.md)的 B3 批次：spec 记录、`specified` 门禁与 `openspecThreshold` 分级。真实 `openspec` CLI 集成（写 `openspec/` 文件并运行 `openspec validate`）属于 B4 的后置命令框架。

## 备选方案

**复用 `record_design` 操作来记录 spec。** 否决：spec 与设计是带不同门禁的不同事实；重载同一个操作会迫使调用方把区分编码进文本。

**现在就折叠进 openspec CLI。** 否决：拉起 `openspec validate` 是后置执行命令，属于 B4；先记录 spec 是领域所需的持久事实。

**用一个固定阈值且无配置来分级到 `l2`。** 否决：阈值随部署而异，因此与设计阈值一样是经过校验的 `Config` 字段。

## 后果

- **获得** spec 记录与 `specified` 门禁，使 `l2` 任务现在被迫记录 spec，并且其分级由第二个可配置规模 proxy 加显式覆盖来选择。
- **代价** 新的 `record-spec` 操作与 `specCount` 字段贯穿 fold、投影及每个工具结果；`openspecThreshold` 增加一个需在 `apply` 时校验的配置字段。
- **延期** 真实 `openspec` CLI 集成（写 `openspec/` 文件并运行 `openspec validate`）与 `.dsh/changes/`/`.dsh/design/` 文件系统产物；spec 记录目前仍仅以 durable 事件存在。
