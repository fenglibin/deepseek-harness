# Agent Note：交付纪律验收门禁

状态：已实现

## 问题

批次 B1–B5 加自动触发（C1）给了任务一个前向生命周期、且现在能自动启动，但 `accepted` 仍然可以在没有任何验证的情况下到达——没有校验已记录的 design 与 spec 是否真的被实现，而且在 `advisory` 下任务可以带着 0 条变更记录完成。设计里的后置闸——"只有全部验证通过才允许进入 accepted"——缺失了。

## 决策

`advance_delivery_task` 现在以两种方式守验收。

- **覆盖确认（C2）。** 对携带 design 或 spec 记录的任务推进到 `accepted` 时，要求一个非空的 `coverage_confirmation` 参数，声明每条已记录的 design/spec 都已实现。`stateful` 下缺失确认会以 `DELIVERY_GATE_BLOCKED` 阻止；`advisory` 下是提醒。确认在推进前被记录为一条持久变更记录，因此它是被记录的陈述，而非沉默的应承。无 design/spec 记录的任务跳过此检查。
- **自动变更记录（C3）。** 当任务以 `changeCount === 0` 到达 `accepted` 时，工具在推进前记录一条概括 objective 的变更，因此任何任务都不会没有变更记录就完成。这只在 `advisory` 下有意义，因为 `stateful` 已经在 `implemented` 前强制了变更记录。

## 备选方案

**Spec checkbox 机检。** 延后：完整 openspec `tasks.md` 布局尚不存在（`record_spec` 写的是 `spec.md`），因此在该布局落地前，spec 覆盖与 design 一样走模型确认。

**默认 `postHooks` 基线。** 作为部署决策延后：`openspec validate --strict` 在没有 `openspec/` 目录的项目上会失败，`pnpm run test` 作为无条件默认又太重。`postHooks` 字段保持可按部署覆盖。

## 后果

- **获得** 程序化后置闸：带 design/spec 记录的任务在模型确认覆盖前无法到达 `accepted`，且每个完成任务都至少有一条变更记录。
- **代价** `advance_delivery_task` 新增一个 `coverage_confirmation` 参数与一个 `changeCount === 0` 的自动记录分支，外加在多次变更之间重新读取任务以保持 CAS ref 最新。
- **延后** openspec `tasks.md` checkbox 检查与默认 `postHooks` 基线。
