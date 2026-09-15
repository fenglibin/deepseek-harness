# 实施清单

## 1. 共享排序器

- [x] 1.1 新增 `packages/client/ui-primitives/src/rank-by-name.ts`：实现 `boundaryBonus` 与 `alignmentScore`（O(name × query) 有序子序列打分，边界 +8、相邻 +4、跳过与前导各 −1） (covers: slash-menu-ranking/子序列查询命中候选, design/D1)
- [x] 1.2 实现并导出 `rankByName<T extends { readonly name: string; readonly title?: string }>(items, rawQuery)`：空查询返回输入数组本身；`title` 作为第二搜索键；排序键为前缀命中、得分、源序 (covers: slash-menu-ranking/空查询不重排, slash-menu-ranking/前缀命中排在前, slash-menu-ranking/按标题子序列命中候选, slash-menu-ranking/标题前缀命中与名称前缀命中同权, design/D1, design/D2, design/D3, design/D4)
- [x] 1.3 在 `packages/client/ui-primitives/src/index.ts` 导出 `rankByName` (covers: slash-menu-ranking/命令与 skill 候选使用同一规则, design/D1)

## 2. 命令候选源改用共享排序器

- [x] 2.1 删除 `packages/client/ui-commands/src/client/service.ts:60-121` 的 `RankedCandidate` 接口、`boundaryBonus`、`fuzzyScore` 与 `fuzzyCandidates` (covers: slash-menu-ranking/命令与 skill 候选使用同一规则, design/D5)
- [x] 2.2 把该文件 `:270-273` 的调用点改为 `rankByName(visible, req.query)`，并移除仅被旧实现使用的导入 (covers: slash-menu-ranking/命令与 skill 候选使用同一规则, design/D1, design/D5)
- [x] 2.3 确认 rows 构造（该文件 `:255-266`）传入的 `title` 被 `rankByName` 作为第二搜索键消费 (covers: slash-menu-ranking/按标题子序列命中候选, design/D2, design/D3)

## 3. skill 候选源改用共享排序器

- [x] 3.1 把 `packages/client/ui-skill/src/client/index.ts:150` 的 `skills.filter(skill => skill.name.startsWith(query))` 改为 `rankByName(skills, query)` (covers: slash-menu-ranking/命令与 skill 候选使用同一规则, design/D1)
- [x] 3.2 在该候选源取目录之前加入子 agent 会话守卫：会话地址为子 agent 时直接返回空列表 (covers: slash-menu-ranking/子 agent 会话没有 skill 候选, design/D6)

## 4. 测试

- [x] 4.1 新增 `packages/client/ui-primitives/tests/rank-by-name.client.spec.ts`：覆盖空查询返回输入本身、大小写不敏感、前缀优先于更强非前缀对齐、相邻与间隔取较大值、非子序列返回空、超长查询返回空、源序稳定 (covers: slash-menu-ranking/子序列查询命中候选, slash-menu-ranking/前缀命中排在前, slash-menu-ranking/空查询不重排, design/D1, design/D4)
- [x] 4.2 在同一 spec 中覆盖 `title` 作为第二键：按标题子序列命中、标题前缀与名称前缀同权、两键得分取较高者 (covers: slash-menu-ranking/按标题子序列命中候选, slash-menu-ranking/标题前缀命中与名称前缀命中同权, design/D2, design/D3)
- [x] 4.3 更新 `packages/client/ui-commands` 的候选过滤用例，断言命令与 skill 使用同一规则、且标题参与匹配 (covers: slash-menu-ranking/命令与 skill 候选使用同一规则, slash-menu-ranking/按标题子序列命中候选, design/D3)
- [x] 4.4 更新 `packages/client/ui-skill` 的候选源用例：原「按 startsWith 过滤」断言改为子序列排序语义，并新增子 agent 会话返回空的用例 (covers: slash-menu-ranking/命令与 skill 候选使用同一规则, slash-menu-ranking/子 agent 会话没有 skill 候选, design/D6)
- [x] 4.5 运行 `jscpd` 确认删除内联实现后无重复代码告警 (covers: slash-menu-ranking/命令与 skill 候选使用同一规则, design/D5)

## 5. 文档

- [x] 5.1 更新 `packages/client/ui-primitives/README.zh.md` 的导出清单，加入 `rankByName` 并说明其排序契约 (covers: slash-menu-ranking/斜杠菜单候选由共享排序器排名, design/D1)
- [x] 5.2 更新 `packages/client/ui-commands/README.zh.md` 与 `packages/client/ui-skill/README.zh.md`，说明候选匹配由共享排序器提供 (covers: slash-menu-ranking/命令与 skill 候选使用同一规则, design/D1)
- [x] 5.3 新增 Agent Note 记录「标题作为第二搜索键」的行为增强，以及 `title` 与官方 `label` 的分叉现状 (covers: design/D2, design/D3)
