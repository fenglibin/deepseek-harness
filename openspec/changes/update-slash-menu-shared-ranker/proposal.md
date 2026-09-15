# 提取共享的名称排序器并用于斜杠菜单

## 为什么

`packages/client/ui-commands/src/client/service.ts` 内联了一套名称排序实现：`RankedCandidate` 接口（`:60`）、`boundaryBonus`（`:68`）、`fuzzyScore`（`:77`）与 `fuzzyCandidates`（`:108`），共约 62 行。它实现了不区分大小写的有序子序列匹配、前缀命中优先、边界与相邻加权、跳过与前导扣分。

同一套语义在 skill 候选源里没有复用：`packages/client/ui-skill/src/client/index.ts:150` 用的是 `skills.filter(skill => skill.name.startsWith(query))`，只做前缀匹配。结果是同一个 `/` 菜单里两个候选源用两种匹配规则，用户输入子序列时 skill 不出现而命令出现。

官方把该实现提取为 `packages/client/ui-primitives/src/rank-by-name.ts`（93 行纯函数），让 `ui-commands` 与 `ui-skill` 共用。

## 做什么

- 新增 `packages/client/ui-primitives/src/rank-by-name.ts`，导出 `rankByName`
- 删除 `ui-commands` 的内联实现，改调 `rankByName`
- 把 `ui-skill` 的前缀过滤改为 `rankByName`
- 补充 `ui-skill` 缺少的子 agent 会话守卫

## 不做什么

- 不把 `InputTriggerCandidate.title` 改名为 `label`：官方在 `5b1bb021cf` 做了这次改名并让 label 成为第二搜索键。本地 `packages/client/ui-input-trigger/src/types.ts:50` 用的是 `title`，改名会波及 `ui-commands`、`ui-skill`、`ui-directory-picker-browse`、`ui-reference` 与相关快照。本变更让 `rankByName` 的泛型约束接受 `title`，保持 API 分叉可追踪
- 不移植 `FileTypeIcon`、`CodeFileIcon`、`LinkIcon` 与配套 artwork：它们的消费方（`ui-sidebar-files`、`ui-sidebar-documentpreview`）在本地不存在，单独移植没有消费者
- 不改菜单分组、图标或本地化顺序

## 影响

- `packages/client/ui-primitives/src/rank-by-name.ts`：新增 93 行
- `packages/client/ui-primitives/src/index.ts`：新增导出一行
- `packages/client/ui-commands/src/client/service.ts`：删除约 62 行内联实现，调用点改为 `rankByName`
- `packages/client/ui-skill/src/client/index.ts`：候选源改为 `rankByName`，并补子 agent 守卫
- 相关测试与快照：`ui-commands` 与 `ui-skill` 的候选过滤用例需按新语义更新

本变更改变 `/` 菜单与 skill 候选的匹配行为（子序列匹配比前缀匹配更宽松，且标题参与打分），属于用户可见行为变更，定为 l1。
