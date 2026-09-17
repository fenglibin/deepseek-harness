## Context

完整背景、已确证事实表与取舍见 `docs/design/delivery-selfcheck-command.zh.md`。核心事实是验收命令只存命令名，正文每次经 `acceptanceBodies`（`packages/delivery/tool-delivery/src/index.ts`）从 `prompt-commands` 命名空间现读，因此「提示词命令」页里的正文就是门禁阻止推进时模型唯一读到的指令；触发点是 `advance_delivery_task` 推进到 `verified`，判定依据是 `acceptanceGap`（`verification.ts`）逐命令检查是否留下 `acceptance: <name> ` 前缀的 `record_change` 记录。

## Goals / Non-Goals

**Goals**：正文成为可执行的自检指令，模型读到后知道读什么、答什么、怎么修、怎么记录；`deep-selfcheck` 成为交付纪律的验收命令，使每个任务在推进到「已验证」前被强制自检。

**Non-Goals**：不改门禁的判定依据（仍只检查是否留下记录）；不改阶段序列与其它三道检查；不改 Host 代码；不把 l0 纳入自检；不在正文里代写记录。

## Decisions

### D1 正文改写为四段，并在第四段给出收尾顺序

原正文只有目标、没有做法。改写为：依据（按级别指明读哪些文件）、三问（完整性／正确性／业务正确性，每条都要可观察证据）、修复、收尾。

第四段不可省，因为它承载两个模型无法从别处得知的硬约束：门禁只认 `acceptance: deep-selfcheck ` 前缀（命令名而非标题）；每次 `record_*` 调用都会让此前取得的 revision 过期。放弃把这两点留给门禁消息：`acceptanceRequirementMessage` 的措辞由 Host 生成，用户改不了，正文才是部署可调的那一处。

### D2 删除与机制不符的级别描述

原正文写「L0、L1 级别的任务可能没有设计文档」。事实是 l1 必然要求至少一条设计记录（`gateAdvance` 要求 `designCount > 0`），l0 不创建任务。改写后按级别写实：L2 读 `openspec/changes/<change_id>/design.md` 与 `tasks.md`，L1 读 `.dsh/design/<task_id>.md` 与 `todo_write` 清单（covers 注解写在清单条目行尾）。

### D3 revision 提醒覆盖全部 record_* 调用

初稿只把该提醒挂在 `record_change` 名下。深度自检读码发现 `recordChange`、`recordTasks`、`recordSpec`、`markAnalyzed` 四处都执行 `current.revision + 1`（`packages/delivery/delivery/src/index.ts`），即每一次 `record_*` 调用都推进 revision；收尾第 1 条补 `covers` 注解若走 `record_tasks` 同样会让此前取得的 revision 过期。措辞已改为「每一次 record_* 调用都会让 revision 加 1，因此每次调用之后都必须重新取」。

### D4 勾选为验收命令，写名字而非正文

`verificationCommands` 取值为 `deep-selfcheck`（命令名，不含前导斜杠）。因为门禁按名字现读正文，以后调整正文不需要重新勾选；若把正文复制进配置，两处会漂移。配置落在 `~/.dsh/settings.yaml` 的用户层，优先于组合配置；`settings-file` 默认 `watch: true`，外部编辑热重载，无需重启 GUI。

## 已验证事实

| 事实 | 证据 |
|---|---|
| 配置生效且正文按名现读 | 真实调用 `advance_delivery_task → verified`，门禁抛 `DELIVERY_GATE_BLOCKED`，错误消息内嵌的正文逐字等于新写入的 20 行 |
| OpenSpec 变更结构合法 | `openspec validate update-delivery-selfcheck-acceptance --strict --json` 退出码 0、`valid: true` |
| settings 热重载生效 | 外部编辑后该文件被 settings 服务规范化重写一次（键序变化），用户值全部保留 |

## 发现但未修的机制问题

`record_spec(kind: "tasks")` 经 `renderTasksMarkdown` 只按内容匹配更新已有行、保留其余旧行。连续两次整体改写清单时，内容不同的行会累加而非替换，直接触发 `checklistMismatch` 门禁。该行为对「渐进补充清单」合理，对「整体替换清单」会持续累积，是否提供显式替换路径属独立问题。

## Risks

- **l0 不触发**：自动建任务只覆盖 l1/l2，l0 没有任务就没有 `verified` 阶段。用户已确认后续单独处理。
- **门禁只保证留下记录**：记录内容为真与否不可机械判定，这是用提示词替代退出码的固有代价。
- **每任务只触发一次**：推进到 `accepted` 后再改代码不会二次触发。
