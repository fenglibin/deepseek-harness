# Agent Note：交付纪律 — 持久化目录与推进门禁修复

Status: implemented

[English](2026-09-03-delivery-persistence-catalog-and-gate.md) | 中文

## 问题

对照[设计](../../../../docs/design/delivery-discipline-rationale.zh.md)对交付纪律子系统做第二次深度自检，发现领域、fold、投影、状态机、CAS、分级、post-hook 与客户端 dock 在端到端 probe 下均正确，但暴露了两处上一次自检遗漏的缺陷：

1. `delivery/change` 会话事件从未注册为「已知事件类型」。`KNOWN_SESSION_EVENT_TYPES` 集合（由 `scripts/gen-persistence-catalog.ts` 生成）驱动持久化读取路径的未知类型拒绝逻辑：持久化日志中若出现不在该集合内且未标记 `ignorable` 的类型，重载时会被拒绝。由于 `delivery/change` 缺失于该集合，任何使用过交付纪律的会话都无法恢复 —— 恰与设计「状态跨会话恢复」的承诺相反。工具目录与配置目录已为新 capability 重新生成，但持久化目录被遗漏了。
2. `advance_delivery_task` 门禁对「层级顺序之外」的阶段给出了误导性的记录前置条件。把 `l0` 任务推进到 `designed`（不在 `l0` 顺序内）会返回「至少需要一条设计记录」，而非领域层的精确「非法迁移」错误，导致模型去修复错误的目标。

## 决策

补齐两处缺陷，不动跨 capability 的延期工作。

- 将 `delivery/change` 加入 `packages/core/session/src/known-event-types.ts`，并把其目录行（`### delivery/*`）加入 `docs/persistence-catalog.md`，与 `gen-persistence-catalog.ts` 对 `packages/delivery/delivery/src/domain.ts` 中 `SessionEventMap` merge 的产出保持一致。该事件保持 log-only（非 surface 类型），且是必需、已知类型 —— 不标记 `ignorable`，因为丢失它会破坏 delivery 投影。
- `gateAdvance` 现在仅在目标阶段是唯一合法下一阶段（`nextDeliveryPhase(view.level, view.phase)`）时才返回记录前置条件；其余目标一律落到领域层，由其以 `DELIVERY_INVALID_TRANSITION` 拒绝。

## 备选方案

**改为把 `delivery/change` 标记为 `ignorable: true` 而非列入已知类型。** 否决：`ignorable` 意味着事件丢失不影响重建，但 delivery 投影依赖每一条 `delivery/change` 事件，因此它是必需的已知类型。仓库内事件走已知类型机制；`ignorable` 留给本构建无法理解的下游事件。

**保持门禁文案不变。** 否决：点名错误前置条件的门禁会重新打开「模型追逐错误修复」这一交付纪律本要消除的失败模式。

## 后果

- **获得** 使用过交付纪律的会话可恢复（持久化读取路径现接受 `delivery/change`），以及越序推进时的精确迁移错误（127 条 delivery 单测，100% 覆盖率；新增「非法迁移而非记录门禁」用例锁定该修复）。
- **代价** 对两个生成文件做手工编辑（当前环境因 `src/` 下陈旧编译产物 `.js`/`.d.ts` 遮蔽源码而无法运行生成器）；持久化目录的 `.zh.md`/`.i18n.yaml` 翻译仍待 `doc-sync` 重新生成。
- **观察但不改动** — record 工具在追加 `.dsh`/`openspec` 产物之前先提交持久化事件，因此文件系统写失败会留下「已提交事件但无磁盘文件」的状态。先提交是有意为之：它避免了更常见的陈旧 revision 路径下的孤儿产物条目，且会话日志是权威，磁盘文件只是投影。
