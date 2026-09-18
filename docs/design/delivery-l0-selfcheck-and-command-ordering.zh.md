# l0 纳入自检与验收命令排序

> 目标读者：维护者
> 关联：[交付纪律方案](delivery-discipline-rationale.zh.md)、[自动触发方案](delivery-discipline-auto-trigger-rationale.zh.md)、[deep-selfcheck 命令文本](delivery-selfcheck-command.zh.md)

## 背景

[deep-selfcheck 命令文本](delivery-selfcheck-command.zh.md)把 `deep-selfcheck` 配成了交付纪律的验收命令，但该门禁只挂在 `advance_delivery_task` 推进到 `verified` 这一步上，而 l0 请求从不创建任务，因此完全不经过这道门禁。用户希望 l0 也被自检覆盖，并且后续会配置多条验收命令，需要能拖动排序、按顺序执行。

## 已确证事实

| 事实 | 位置 |
|---|---|
| l0 的阶段序列本身已经包含 `verified` | `packages/delivery/delivery/src/fold.ts` `LEVEL_PHASES` |
| 自动建任务只对 l1/l2 生效，l0 只注入分级判据 | `packages/delivery/tool-delivery/src/index.ts` `agent/pre-step` 监听器 |
| `create` 只在当前任务为 `accepted` 时允许新建，否则抛 `DELIVERY_ALREADY_EXISTS` | `packages/delivery/delivery/src/index.ts` |
| `clear` 在服务层存在并留下可追溯 tombstone，但没有对应工具 | 同上 `clear` |
| `checklistGap` 对 l0 豁免清单义务，`requirementCoverageGap` 对 l0 豁免注解覆盖 | `packages/delivery/tool-delivery/src/verification.ts` |
| 验收命令是 `string[]`，数组顺序天然承载执行顺序，Host schema 无需改动 | `packages/delivery/tool-delivery/src/index.ts` `Config` |
| `acceptanceGap` 当前返回**全部**缺失命令，不区分先后 | `verification.ts` |
| 仓库无拖拽库，已有原生 HTML5 拖拽先例 | `packages/client/ui-workspace/src/client/rows/Rows.tsx` |

## D1 l0 自动建任务，但必须同时解决「任务粘连」

放开 `index.ts` 的级别条件即可让 l0 走完 `created → implemented → verified → accepted`，验收命令门禁随之生效。但单独放开这一处会制造一个比原问题更严重的缺陷。

`create` 的规则是「当前任务非 `accepted` 时拒绝新建」，而 l0 请求通常是小修，模型不会把它推进到 `accepted`。于是第一个 l0 任务会停在 `created` 或 `implemented`，此后**每一个**新请求（包括正常的新请求）都会撞上 `DELIVERY_ALREADY_EXISTS`，且模型没有工具可以清空它。用户失去的是「继续对话」这一最基本的能力。

因此 D1 与 D2 必须一起交付，不能只做其中一个。

## D2 l0 任务被新的直接人类请求替换

在 `agent/pre-step` 创建任务前，若当前存在一个**未完成的 l0 任务**且本步收到了新的直接人类请求，则先 `clear` 它、再创建新任务。

范围严格限定在 l0：l1/l2 的粘连是刻意的——大任务需要连续性，一个正在进行的大任务不该被下一条消息冲掉。l0 是彼此独立的小微修复，把上一个小修的任务留成路障没有意义。

`clear` 留下 tombstone 且进入会话日志，因此被替换的任务仍可追溯，不是静默丢弃。

替换判定落在 `tool-delivery` 的 `createReplacingL0` 一处，`agent/pre-step` 与 `create_delivery_task` 共用它：模型显式提高分级（把一个 l0 任务换成 l1/l2）与自动路径因此行为一致。未完成的非 l0 当前任务以 `DELIVERY_TOOL_TASK_EXISTS` 拒绝，错误消息说明只有 l0 或已 accepted 的任务可被替换。已 accepted 的任务由 `DeliveryService.create` 自己的规则放行（它只在当前任务非 accepted 时拒绝新建），因此那种情形直接新建、不写 tombstone。

**已知代价**：l0 的自检保护是「尽力而为」的。模型若在同一个回合内没走完 `verified`，下一个请求会替换掉该任务，那次自检就没被门禁强制。这是让 l0 保持轻量的必然取舍：要让它成为硬保证，l0 就得像 l1 一样要求用户等待完整流程走完。l1/l2 不受影响，它们的门禁仍是硬的。

## D3 保留 l0 对清单与注记的豁免

l0 纳入的是「验收命令门禁」这一道，不是全部四道。`checklistGap` 与 `requirementCoverageGap` 对 l0 的现有豁免保持不变，否则每个改文案、修拼写的小修都要先写清单并标注 `covers`，与 l0「小微修复」的定位直接冲突。

代价是 l0 仍然必须留下至少一条 `record_change` 才能到 `implemented`（`gateAdvance` 的既有规则）。这是既有行为，本次不改变。

## D4 验收命令按配置顺序逐条校验

`acceptanceGap` 的返回值由 `readonly string[]`（全部缺失命令）改为 `AcceptanceGap | undefined`：最早缺失的那一条命令，加它的 1-based 位置与总数。门禁消息说明当前是第几条、共几条，并只给出这一条的提示词正文。

理由是把顺序变成机械可判定的事实：模型执行完第 1 条并记录后，第 2 条才会被要求，无法跳着做或一次宣称全部完成。若仍一次列出全部缺失项，顺序就只是消息里的排版，模型可以任意顺序记录，也可能只挑容易的那条。

## D5 客户端拆成「已选顺序列表 + 候选勾选」

`verificationCommands` 的数组顺序就是执行顺序，因此呈现必须让顺序可见可改。

- 已选区：按顺序渲染，带序号，支持拖动调整、方向键调整、单条移除。
- 候选区：未选中的命令，勾选即追加到末尾。
- 已选但已不存在的命令继续渲染在已选区，可移除（既有行为，保留）。

方向键是必需的而不是可选的：仓库的 [Web 样式规范](../../docs/web-styling.zh.md)要求交互控件保留键盘可达路径，纯拖拽不满足。拖动与方向键共用同一个「移动到目标下标」的控制器动作，因此两条路径不会产生两套顺序语义。

Host schema 不变（仍是 `string[]`），这是纯客户端交互升级加一处门禁判定收紧。

## 备选方案

**只放开 l0 建任务，不管粘连。** 否决：会让 l0 成为后续所有请求的路障，且模型没有 `clear` 工具可以自救，是把一个覆盖缺口换成可用性缺陷。

**给模型加一个 `clear_delivery_task` 工具。** 否决（本变更范围内）：那要求模型主动记得清理，是「靠自觉」的失败模式；`pre-step` 的自动替换不依赖模型行为。若将来 l1/l2 也需要放弃任务的路径，应单独评估。

**l0 也走完整四道检查。** 否决：用户已确认保留豁免；对小修要求写清单与标注注解会显著加重负担，且 l0 的定位就是不需要这些产物。

**验收命令改为一次校验全部顺序。** 否决：要求模型一次提交按序的全部记录，门禁就无法指出「下一条是哪条」，模型需要自己比对顺序，失败时的诊断也更差。

**只做拖动、不做方向键。** 否决：与仓库既有的键盘可达性要求冲突。
