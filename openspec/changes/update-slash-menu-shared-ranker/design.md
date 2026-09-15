# 技术决策

设计草案见 [docs/design/upstream-diff-analysis.zh.md](../../../docs/design/upstream-diff-analysis.zh.md) 第 3.1 节。本文件记录决策编号，供 tasks.md 锚定。

### D1 排序器是纯函数，放在 ui-primitives

`rankByName` 只依赖入参，不接触 `ctx`、不注册服务、不读写 store。放在 `packages/client/ui-primitives` 使 `ui-commands` 与 `ui-skill` 都能导入而不引入新的包依赖边。

算法为不区分大小写的有序子序列匹配，复杂度 O(name × query)：query 的每个字符必须按序出现在 key 中。排序键依次为前缀命中、对齐得分、源序。

### D2 泛型约束接受 title，与官方 API 分叉

官方 `rankByName<T extends { readonly name: string; readonly label?: string }>` 的 `label` 来自 `5b1bb021cf` 对 `InputTriggerCandidate` 的改名。本地该接口仍用 `title`（`packages/client/ui-input-trigger/src/types.ts:50`，注释为 `Localized display title; the menu shows it instead of name when present`）。

本变更把泛型约束写为 `{ readonly name: string; readonly title?: string }`，使本地调用方无需改名即可获得"标题参与搜索"的行为。

三个方案的取舍：改名 `title` → `label` 能对齐官方，但波及 `ui-input-trigger`、`ui-commands`、`ui-skill`、`ui-directory-picker-browse`、`ui-reference` 与快照；同时接受两个同义字段会让类型契约含糊。本变更选择最小改动，把改名留给后续独立的菜单重排批次。

### D3 标题作为第二搜索键是行为增强

本地 `fuzzyScore` 只对 `name` 打分，`title` 完全不参与匹配。`rankByName` 把 `title` 作为第二键，任一键的子序列命中即入选，得分取两键较高者，前缀命中任一键即为真。

后果是 `/` 菜单中输入本地化标题也能匹配到命令。这是用户可见的增强，需同步更新既有测试断言。

### D4 空查询返回输入数组本身

`rankByName` 在 `rawQuery` 为空时直接返回 `items`（引用相等），不做排序也不复制。本地 `fuzzyCandidates` 同样是空查询早返回，行为一致。

该选择让调用方可以依赖"未输入查询时不重排"，也避免了每次空查询的数组分配。

### D5 删除本地内联实现，不留两份

本变更删除 `ui-commands` 的 `RankedCandidate`、`boundaryBonus`、`fuzzyScore` 与 `fuzzyCandidates`。保留两份实现会让 `jscpd` 重复检测报错，也会让两处语义在未来漂移。

### D6 补子 agent 会话守卫

官方 `ui-skill` 的候选源在取目录前有 `if (sessions.subagentAddress(session.sessionId) !== undefined) return []`，使子 agent 会话不暴露 skill 候选。本地缺该守卫。它与排序器无关，但同属该候选源的契约，一并补齐。

## 被拒绝的方案

**保留本地 `fuzzyCandidates` 并在 `ui-skill` 单独调用它**：不采用。跨包调用需要把该函数导出并建立 `ui-skill` → `ui-commands` 的依赖边，方向错误（skill 是候选源，commands 是菜单宿主）。

**把 `title` 改名并入本变更**：不采用。改名会牵动 5 个包与大量快照，与本变更的"提取共享排序器"目标无关，混在一起会让回归面难以界定。

**让 `rankByName` 同时接受 `label` 与 `title`**：不采用。两个同义可选字段会让类型契约含糊，且调用方无法从类型判断该填哪个。
