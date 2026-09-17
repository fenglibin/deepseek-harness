# 交付纪律 deep-selfcheck 命令文本与验收命令配置

## 背景

用户希望交付纪律做到「任务每次执行完成后都执行深度自检并自动修复存在的问题」，做法是改写「设置 → 提示词命令」中 `deep-selfcheck` 的正文，再把它勾选到交付纪律的「验收命令」。

本变更交付的是这次配置本身，以及支撑它的机制结论。机制结论经读码确证，不是推断；配置是否真的生效经一次真实的门禁调用确证。

## 已确证事实

| 事实 | 位置 |
|---|---|
| 验收命令存命令名（不含前导斜杠），正文每次从 `prompt-commands` 命名空间现读 | `packages/delivery/tool-delivery/src/index.ts` `acceptanceBodies` |
| 触发点是 `advance_delivery_task` 推进到 `verified`，不在回合结束时 | 同上，`phase === 'verified'` 分支 |
| 判定依据是「是否留下 `acceptance: <name> ` 记录」，逐命令计数 | `verification.ts` `acceptanceGap` |
| 阻止时门禁消息携带提示词正文 | `acceptanceRequirementMessage` |
| 自动建任务只覆盖 l1/l2，l0 只注入分级判据 | `index.ts` `agent/pre-step` 监听器 |
| 每一次 `record_*` 调用都让 revision 加 1 | `packages/delivery/delivery/src/index.ts` 的 `recordChange`/`recordTasks`/`recordSpec`/`markAnalyzed` |
| `settings-file` 默认 `watch: true`，外部编辑热重载 | `packages/settings/settings-file/src/index.ts` |

## D1 正文改写为「依据 + 三问 + 修复 + 收尾」四段

原正文是一句被插入语打断的长句，只陈述目标，不含做法，也没有交代它是在门禁阻止时被读到、必须留下记录才能放行。

改写为四段：自检依据按级别写实（L2 读 `openspec/changes/<id>/` 的 `design.md` 与 `tasks.md`，L1 读 `.dsh/design/<task-id>.md` 与 `todo_write` 清单）；第二段把「完整性、正确性、业务正确性」变成三个必须逐条回答并给出可观察证据的问题；第三段要求直接修复；第四段给出收尾顺序与 `acceptance:` 记录格式。

第四段不可省：门禁只认 `acceptance: deep-selfcheck ` 前缀的记录，且每次 `record_*` 调用都会让此前取得的 revision 过期。这两点在原正文里完全缺失，是模型最可能卡住的地方。

原正文中「L0、L1 级别的任务可能没有设计文档」与事实不符：l1 一定要求 `designCount > 0`（`gateAdvance`），l0 根本不建任务。改写后按级别写实，不再保留这处错误。

## D2 勾选 `deep-selfcheck` 为验收命令

写入 `delivery` 命名空间的 `verificationCommands`，取值为命令名 `deep-selfcheck`。写名字而非正文，因此以后在「提示词命令」页调整正文不需要重新勾选。

配置落在 `~/.dsh/settings.yaml`（用户层覆盖，优先于组合配置），与 `prompt-commands` 的正文改动同时生效。按仓库规则，随部署变化的内容走设置而非常量；`settings-file` 默认 `watch: true`，外部编辑热重载，无需重启 GUI。

## D3 revision 提醒覆盖全部 record_* 调用

正文收尾段提醒「记录之后 revision 会变」。初稿只把该提醒挂在 `record_change` 名下，深度自检时读码发现 `recordChange`、`recordTasks`、`recordSpec`、`markAnalyzed` 四处都执行 `current.revision + 1`，即每一次 `record_*` 调用都推进 revision。收尾第 1 条补 `covers` 注解若走 `record_tasks`，同样会让此前取得的 revision 过期。措辞已改为「每一次 record_* 调用都会让 revision 加 1，因此每次调用之后都必须重新取」。

## 已验证事实

以下经真实调用或命令确证。

| 事实 | 证据 |
|---|---|
| 配置生效且正文按名现读 | 真实调用 `advance_delivery_task → verified`，门禁抛 `DELIVERY_GATE_BLOCKED`，错误消息内嵌的正文逐字等于新写入的 20 行 |
| OpenSpec 变更结构合法 | `openspec validate update-delivery-selfcheck-acceptance --strict --json` 退出码 0、`valid: true`、issues 为空 |
| settings 热重载生效 | 外部编辑后该文件被 settings 服务规范化重写一次（键序变化），用户值全部保留 |

## 发现但未修的机制问题

`record_spec(kind: "tasks")` 经 `renderTasksMarkdown` 只按内容匹配更新已有行、保留其余旧行（`packages/delivery/tool-delivery/src/index.ts`）。连续两次整体改写清单时，内容不同的行会累加而非替换，直接触发 `checklistMismatch` 门禁。该行为对「渐进补充清单」合理，对「整体替换清单」会持续累积，是否提供显式替换路径属独立问题。

## D4 保留的已知局限

- **l0 曾不触发，现已纳入。** 本变更交付时自动建任务只对 l1/l2 生效，l0 没有任务就没有 `verified` 阶段。[l0 纳入自检与验收命令排序](delivery-l0-selfcheck-and-command-ordering.zh.md)已把 l0 也纳入，并保留它对清单与 `covers` 注解的豁免。
- **门禁只保证「留下了记录」。** 这是用提示词替代退出码的固有代价，模型写一条无信息的记录同样放行。
- **每个任务只触发一次。** 推进到 `accepted` 之后再改代码不会二次触发。

## 备选方案

**不配置为验收命令，只保留手动 `/deep-selfcheck`。** 否决：用户明确要求「任务每次执行完成后都执行」，手动调用依赖模型自觉，不构成门禁。

**改 Host 代码让正文内建、不依赖 settings。** 否决：正文是随部署变化的可调项，按仓库规则必须是可从配置修改的字段，而不是硬编码进插件。

**在门禁消息里代写记录、绕过模型自述。** 否决：没有记录就放行等于取消门禁；门禁的确定性来自「记录缺失就是缺失」这一可机械检查的事实。
