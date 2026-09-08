## Why

交付纪律子系统的 openspec 拆分链路未闭合。一次真实大需求（objective 367 字符）被字符地板判为 `l1`，因此从未进入 `specified` 阶段，全会话没有 spec 记录；工作分解由 `todo_write` 承担，其状态由模型自报、无机器证据、不落盘到 git，且下一轮次清空。左侧悬浮卡片只渲染六个生命周期阶段，与子任务完全不通气。即便任务被判为 `l2`，`record_spec` 也只是把自由文本追加到单个 `spec.md`，既不是 openspec 的 change 布局，也没有接入 `openspec validate`。

## What Changes

- 规模分级改为三层判定：字符地板（>200 → `l2`）、强信号扫描、模型 rubric，使大需求稳定进入 `l2`。
- `l2` 任务产出 openspec change 四件套（proposal/design/tasks/specs），并接入 `openspec validate --strict` 作为门禁。
- 左侧悬浮卡片改为「阶段 + 子任务」双进度，阶段推进时自动切换并展开。
- `l2` 以 openspec `tasks.md` 为唯一任务源，`todo_write` 在该级别下被拦截。
- 验收执行逐点验证闭环：验证点清单程序化提取、`covers:` 双向索引、覆盖完整性与行为正确性四层校验；校验带坡度，覆盖类差异可复核放行，命令失败类必须真绿。
- 阈值与信号清单集中到设置服务的 `delivery` namespace，供后续「设置」统一管理。
