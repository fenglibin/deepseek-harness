- [revision 10] 新增宿主包 `packages/fs/file-changes`（`@deepseek-ai/dsh-file-changes`），成为第一方文件变更词汇的唯一归属方，并提供全会话 `changedFiles` 投影单元。

- `src/mutation.ts`：`mutationTarget(name, argsRaw)` 判定哪些调用算变更——`write` 读 `file_path` 且要求有 `content`，`edit` 读 `file_path` 且要求 `old_string` 非空且与 `new_string` 不同，`str_replace_editor` 读 `path` 且只认 `create`/`str_replace`/`insert`。只读命令、不受支持的工具、无法解析的 JSON 与不完整参数都返回 null。
- `src/path.ts`：`canonicalMutationPath(path, cwd)` 按会话 cwd 解析、统一分隔符、消解 `.`/`..` 与重复斜杠。这是折叠键与客户端键的唯一实现。
- `src/fold.ts`：`stepFileChanges(state, event)` 纯转移 + `changedFilesView(state)`。状态为 `{ cwd, files, pending }`，`files` 每个被改过的不同路径一条，`pending` 只保留未结算的变更调用（结果落地即移除，`turn/end` 丢弃该轮残留），因此状态不随日志增长——这是它可进投影缓存的前提。`init(header)` 捕获 cwd，使 `apply` 保持纯函数。
- `src/projection.ts`：`changedFilesProjectionDefinition`（zod state/view schema、`stateVersion: 1`）。
- `src/client.ts`：`/client` 出口，导出词汇与规范化供浏览器端复用。
- `src/index.ts`：经 `ctx.inject(['sessionProjections'])` 注册单元，注册表缺席时不注册。
- `package.json` / `tsconfig.json` / `src/invariant.ts` / `README.zh.md`；注册进 `tsconfig.host.json`、`tsconfig.base.json` 的 paths、web-app bundle 与 bundle 依赖。
- `tests/fold.spec.ts`（19 条：规范化、词汇判定、成功/失败结果、去重与 seq 边界、三工具、轮次中断丢弃、真实 Session 日志）与 `tests/loader-composition.spec.ts`（2 条：真实 Loader 组合下经注册表读到变更文件、无 default export）。
- [revision 11] 「修改的文件」dock 改为读全会话投影，接受语义改为按 (路径, lastSeq) 比较。

- `SessionChangesDock.tsx`：`ProducedChange` 换成 `SessionChange { path, operation, firstSeq, lastSeq }`；新增 `pendingChanges(changes, accepted)` —— 某路径 `lastSeq` 大于已接受 seq 即为待处理，这一条规则同时实现「接受后隐藏」与「再次变更后重现」；`sessionChanges` 回退折叠改为同样产出 seq 边界并按 `firstSeq` 排序；adapter 先读 `useProjection('changedFiles')`，缺席时回退窗口折叠；接受集由 `ReadonlySet<string>` 改为 `AcceptedChanges = Record<path, lastSeq>`；`onAccept`/`onAcceptAll` 改为接收 `SessionChange`。
- `locales.ts`：标题由「本次修改的文件」改为「修改的文件」。
- `src/client/index.ts`：导出新的 `pendingChanges`/`SessionChange`/`AcceptedChanges`，新增 `dsh-file-changes/client` 的 type-only 导入。
- `package.json` / `tsconfig.json`：新增 `dsh-file-changes` 包边。
- `tests/session-changes-dock.client.spec.tsx` 扩到 39 条，新增：`pendingChanges` 四条（无接受全待处理、接受后隐藏、更新变更重现、无新变更保持隐藏）、面板层「lastSeq 更新后重现」、adapter 层「全部接受后再次变更重现」、以及「优先用投影而非已加载窗口」与「投影缺席时回退」。
- [revision 12] `ui-deliverables` 复用共享变更词汇，删除本地重复解析；文档与门禁同步。

- `turn-deliverables.ts`：删除本地 `mutationPath`/`mutationOperation`/`validEditArgs`/`editorMutationPath`/`pathValue`/`isRecord` 六段重复实现，改为从 `@deepseek-ai/dsh-file-changes/client` 取 `mutationTarget`；`MutationOperation` 改为再导出。界面行为不变（该包 31 条测试全通过）。
- `packages/client/tsdown.client.ts`：`INLINE_SAFE` 放行 `@deepseek-ai/dsh-file-changes/client`（纯折叠、无运行时共享身份），与 `dsh-token-meter/client` 同一机制。
- `scripts/verify-package-readme-model-experience.ts`：把 `packages/fs/file-changes` 登记进无模型体验的审计名单（该单元只折叠已写入日志的事件）。
- `packages/bundle/web-app/cordis.patch.yml` 与 `package.json`：挂载并依赖新包，带可移除注释。
- 文档：新增 `packages/fs/file-changes/README.zh.md`（含 Model Experience 与 Known Limitations）；更新 `packages/fs/README.zh.md`（包表加入新包）、`ui-session-changes/README.zh.md`（数据源、接受语义、限制项）、`ui-deliverables/README.zh.md`（词汇归属）。
- [revision 13] Agent Note 与覆盖收尾；supersession 检查发现并修掉一处我自己引入的重复。

- 新增 `.agents/notes/implemented/feature/2026-09-14-session-changed-files-whole-log.zh.md`：记录缺陷 A（窗口折叠）/缺陷 B（接受无变更身份）的实测证据、D1–D9 决策与各自否决的替代方案、后果、Testing 与 Deferred。
- supersession 检查：两份既有笔记（`2026-09-03-chat-ux-session-changes-dock`、`2026-09-08-session-changes-dock-paths`）判为**部分**取代——保留活跃、互相交叉链接，并在原地更正已过时的事实（数据源、`producedChangesForClosing` 已不存在、接受语义、`canonicalMutationPath` 归属上移、标题文案、测试条数）；`2026-09-03` 中「否决 session projection」一条显式标注判断已被推翻并指向新笔记。无笔记归档（两份都仍拥有未来决策价值），`verify-archived-agent-notes` 通过。
- **修掉一处自己引入的重复**：我最初在 dock 里又写了一份 `canonicalMutationPath`，与 `dsh-file-changes/src/path.ts` 重复——正是本次要消除的那类缺陷。改为从 `@deepseek-ai/dsh-file-changes/client` 引入并再导出，dock 不再持有实现。
- 覆盖率补齐到 100% 且无豁免：删除 `mutationPath` 中因 `mutationOperation` 已过滤而不可达的 `default` 分支（合并两个 switch）；新增词汇边界用例（空/非字符串路径、`replace_all` 非布尔、`insert_line` 负数与小数、`new_str` 非字符串、`create` 缺 `file_text`、未知编辑器命令）、替换来源结果不计入、无工作区根时保留相对路径，以及 node half 与 invariant companion 的包壳覆盖。
- 修掉 host 面抓到的类型错误：`fold.spec.ts` 里 `turn/end` 的 `reason` 由字符串改为 `{ kind: 'completed' }`。
- 重新生成 `docs/module-graph.zh.md`（唯一一处由本次改动合法产生的生成物；其余生成物漂移经 stash 验证为既有）。
- [revision 18] 按记录的能力增量逐条核对覆盖，补齐两处缺失锚点并修正 OpenSpec 格式。

- 逐条核对 spec 的 7 条需求 / 13 个 Scenario 与测试锚点，发现两个 Scenario 此前没有直接锚点：「接受不动磁盘」与「接受状态不跨页面刷新保留」。新增两条测试——接受只点「全部接受」并断言注入的 `openFile` 从未被调用（dock 通往宿主只有这一条通道）；接受后 unmount 再 mount，断言列表重新出现该变更（组件本地状态，刷新即重建）。
- `openspec/changes/add-session-changed-files-log/specs/session-changed-files/spec.md` 改为 OpenSpec 认得的 delta 格式（`## ADDED Requirements` + `### Requirement:`），`openspec validate add-session-changed-files-log --strict` 由「No delta sections found」转为 **valid**。
- `tasks.md` 重写为恰好 7 条与记录清单一致（此前 `record_spec` 追加导致 13 条重复）。
- 最终：三个包 103 条测试通过；两个新包 `src/**` 覆盖率仍为 100%（无豁免）；`run-oxlint` 0 警告 0 错误；`tsc -b tsconfig.client.json` 与 `tsc -b tsconfig.host.json` 均干净。
- [revision 19] coverage confirmation: 每条记录的 design 与 spec 都已实现并有测试锚定。D1 全量事实由宿主投影提供 → `changedFiles` 单元 + dock 的 `useProjection('changedFiles')`，测试覆盖「变更位于已加载窗口之外」与「长会话中列表不随分页缩短」；D2 词汇唯一归属 → `mutation.ts`/`path.ts`，dock 与 `ui-deliverables` 都从 `dsh-file-changes/client` 读取，测试覆盖三工具、只读命令、参数边界与两种拼写收敛；D3 有界状态 → `fold.ts` 的 `{cwd, files, pending}` + `init(header)`，测试覆盖轮次中断丢弃与无关事件返回同一状态引用；D4 接受按 (路径, lastSeq) → `pendingChanges`，测试覆盖「再次变更重现」「无新变更保持隐藏」「全部接受后仅新变更重现」；D5 投影缺席回退 → 两条数据源路径，测试覆盖「优先用投影」与「缺席时回退」；D6 接受状态组件本地 → 测试覆盖「重新挂载后全部变更重新待处理」；D7 标题改「修改的文件」 → `locales.ts` 并由全部面板测试经 `t('title')` 断言；D8 产物行不动 → `ui-deliverables` 31 条测试行为不变；D9 bundle 放行 → `INLINE_SAFE` 加 `dsh-file-changes/client`，`client-bundle-purity` 通过。spec 的 7 条需求 / 13 个 Scenario 均有对应测试（含本轮补齐的「接受不动磁盘」与「刷新后列表重建」两个此前缺失的锚点）。两个新包 `src/**` 覆盖率 100% 无豁免。
- [revision 21] 深度自检：用真实日志端到端校验，发现并修复两处真实的顺序相关缺陷。

自检方式（不只是"代码不报错"）：
1. 真实未修改的 54 轮会话日志（1115 个 tool/call、1119 个 tool/result）驱动投影，与独立重算逐条比对——84 个路径与 operation 完全一致，零缺失零多余；其中 21 个文件被改动多次，正是「接受后重现」必须生效的场景。
2. 新增端到端测试（真实日志 → 真实投影单元 → 真实 dock 组件）：接受 → 新回合加文件（已接受文件保持隐藏）→ 再改已接受文件（重现）；全部接受后仅被重新变更的文件回来；接受不调用宿主打开器（不动磁盘）；重新挂载后列表重建。

发现并修复的真实缺陷（两处同源：折叠按到达顺序而非按 seq）：
- **回退路径（dock）**：`sessionChanges` 用「先到者」定 operation/firstSeq。历史页 prepend 后 turns 迭代顺序可能早于时间顺序，导致 operation 与 firstSeq 取错、lastSeq 可倒退——而 lastSeq 正是接受语义的比较基准，倒退会隐藏读者未接受的变更。改为按 seq 折叠（最早者定 operation 与 firstSeq，最晚者定 lastSeq），结果与到达顺序无关。
- **宿主折叠（file-changes）**：`recordMutation` 同样按到达顺序，且带一处 `unchanged` 提前返回：它只比较 operation 与 lastSeq，会静默丢弃 firstSeq 的修正（实测：先 write@5 再 write@3，firstSeq 仍停在 5）。改为按 seq 折叠并删除该提前返回——它是死代码（recordMutation 只在新的成功结果结算时到达，此时 pending 必变），且带 bug。

同时按「require a current owner and need」删除我自己上一轮加的投机复杂度：dock 里 `turnOrder` + leftovers 双路遍历（引擎本就从同一个 Map 按 firstSeq 派生 turnOrder，两者不可能不一致；seq 折叠才是真正的修复，迭代顺序已不影响结果）。

结果：三个包 114 条测试通过；两个新包 `src/**` 覆盖率 100% 无豁免（删除死代码而非加 v8 ignore）；client/host 两个面 typecheck 干净；lint 0 警告 0 错误。
