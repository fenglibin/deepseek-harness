# Agent Note：交付纪律深度自检

Status: implemented

[English](2026-09-03-delivery-discipline-deep-self-check.md) | 中文

## 问题

对照[交付纪律设计](../../../../docs/design/delivery-discipline-rationale.zh.md)对 B1–B3 批次做深度自检，发现领域、fold、投影、状态机、CAS 与门禁在端到端 probe 下均正确，但暴露了三个具体缺口：(1) §6.4 规模 proxy 只实现了 `descriptionChars`，漏掉了 `todoCount`/`touchedFiles` 与 `requireOpenspecForBugs`；(2) `runtime.ts` 带有一处 `oxlint-disable-next-line`（针对 `no-useless-constructor`），违反「禁止 lint 抑制注释」规则；(3) 缺少把 `l1`/`l2` 任务走到 `accepted`、以及替换 accepted 任务的端到端测试。

## 决策

补齐 §6.4 配置完整性与两处卫生问题，不动跨 capability 的延期工作。

- `@deepseek-ai/dsh-tool-delivery` 的 `Config` 新增 `designThreshold.todoCount`（默认 `5`）、`designThreshold.touchedFiles`（默认 `3`）、`openspecThreshold.todoCount`（默认 `15`）与 `requireOpenspecForBugs`（默认 `true`）。`create_delivery_task` 接受可选的 `todo_count`、`touched_files` 与 `is_bug` 预估值；省略 `level` 时，`inferLevel` 在任一 openspec 度量达标时分级 `l2`，再在任一 design 度量达标时分级 `l1`，并在 `requireOpenspecForBugs` 下把非小微 bug（`is_bug` 且超过 design 阈值）强制为 `l2`。
- `DeliveryError` 删除仅 `super` 透传的构造函数（`no-useless-constructor` 触发点），改用 `declare readonly code: DeliveryErrorCode`，移除 delivery 包内唯一一处 lint 抑制注释。
- 新增端到端 delivery 测试：`l1`/`l2` 完整生命周期到 `accepted`、accepted 任务替换、以及三条新的分级路径。

## 备选方案

**保持仅 `descriptionChars` 分级。** 否决：设计列出了三个 proxy 与一个 bug 强制 L2 开关，单一度量不足以交付 §6.4 的可配置性。

**保留 `DeliveryError` 构造函数并带 lint 抑制。** 否决：禁止 lint 抑制是绝对的；`declare` 收窄表达了同样的类型级意图。

## 后果

- **获得** §6.4 完整的规模 proxy 集合与 `requireOpenspecForBugs`、零 lint 抑制、端到端生命周期覆盖（92 条单测，100% 覆盖率）。
- **延期（不变，跨 capability）** — 写 `.dsh/changes/` / `.dsh/design/` 文件与真实 `openspec` CLI（`create`/`validate`/`archive`）仍需 `fs`/subprocess 集成；`postHooks`（B4）与客户端 UI（B5）仍是后续批次。
