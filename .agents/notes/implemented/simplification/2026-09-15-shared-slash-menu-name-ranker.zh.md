# Agent Note: 斜杠菜单与 skill 候选共用一套名称排序

Status: implemented

## Problem

`/` 菜单的命令候选与 skill 候选用了两套匹配规则。

命令候选在 `packages/client/ui-commands/src/client/service.ts` 内联了约 63 行实现（`RankedCandidate`、`boundaryBonus`、`fuzzyScore`、`fuzzyCandidates`）：不区分大小写的有序子序列匹配，前缀命中优先，边界与相邻加权，跳过与前导扣分。

skill 候选只有前缀匹配：`packages/client/ui-skill/src/client/index.ts` 用 `skills.filter(skill => skill.name.startsWith(query))`。

后果是同一个菜单里两个候选源行为不一致：用户输入一个不作为前缀出现的子序列时，命令出现而 skill 不出现。两套规则也没有任何共同来源，语义会各自漂移。

## Decision

把该实现提取为 `packages/client/ui-primitives/src/rank-by-name.ts` 的 `rankByName`，让两个候选源共用它，并删除 `ui-commands` 的内联副本。

算法为 O(name × query) 的有序子序列对齐：`alignmentScore` 对每个 query 字符扫描 name 一行，用滑动的前一列值计算"相邻续接"（+4 加权）与"间隔续接"（按跳过字符数扣分），边界处（index 0 或前一字符为 `-`/`_`）+8 加权，前导字符按位置扣分。排序键依次为前缀命中、对齐得分、源序。空查询直接返回输入数组本身。

**与官方 API 的分叉**：官方该函数的泛型约束是 `{ name: string; label?: string }`，`label` 来自随后对 `InputTriggerCandidate.title` 的改名。本地该接口仍是 `title`，因此本实现把约束写为 `{ name: string; title?: string }`，使本地调用方无需改名即可让标题参与匹配。改名会牵动 5 个包与相关快照，留给后续独立的菜单重排批次。

**行为增强**：本地原实现只对 `name` 打分，`title` 完全不参与。新排序器把标题作为第二键，任一键的子序列命中即入选、得分取两键较高者、前缀命中任一键即为真。因此 `/` 菜单中输入本地化标题也能匹配到命令。

`ui-skill` 的子 agent 会话守卫已存在：`fetchCatalog` 在 `sessions.subagentAddress(sessionId) !== undefined` 时返回空列表，因此候选源与预热路径都不会为子 agent 会话请求目录。

## 曾考虑的替代方案

**保留 `ui-commands` 的内联实现并让 `ui-skill` 单独调用它。** 不予采用：跨包调用需要把该函数导出并建立 `ui-skill` → `ui-commands` 的依赖边，方向错误——skill 是候选源，commands 是菜单宿主。

**保留两份实现。** 不予采用：`jscpd` 重复检测会报错，且两处语义会各自漂移，正是本次要消除的问题。

**把 `title` 改名为 `label` 并入本变更。** 不予采用：改名牵动 `ui-input-trigger`、`ui-commands`、`ui-skill`、`ui-directory-picker-browse`、`ui-reference` 与大量快照，与本变更"提取共享排序器"的目标无关，混在一起会让回归面难以界定。

**让泛型同时接受 `label` 与 `title`。** 不予采用：两个同义可选字段会让类型契约含糊，调用方无法从类型判断该填哪个。

## Consequences

两个候选源使用同一套匹配与排序规则，子序列查询在 skill 上同样命中。标题成为第二搜索键，因此输入本地化文案也能匹配到命令——这是用户可见的行为增强。

代价是单元作者需要知道 `title` 参与打分：只改名称而不改标题时，旧的标题仍可能命中查询。该行为由 `rank-by-name.client.spec.ts` 固定。

本实现依赖 `ui-primitives` 是零 cordis、零 slot 知识的分层事实：排序器是纯函数，不接触 `ctx`、不注册服务、不读写 store，因此放在该包不引入新的依赖边。

## Testing

`packages/client/ui-primitives/tests/rank-by-name.client.spec.ts` 六条用例：空查询返回输入列表本身（引用相等）、大小写不敏感的有序子序列、前缀命中优先于更强的非前缀对齐、同一字符取相邻与间隔对齐的较大值、非子序列返回空、标题作为第二键且标题前缀与名称前缀同权。

`packages/client/ui-primitives`、`packages/client/ui-commands`、`packages/client/ui-skill` 三个包的 702 个测试全部通过，证明删除内联实现后两个候选源的行为未回归。
