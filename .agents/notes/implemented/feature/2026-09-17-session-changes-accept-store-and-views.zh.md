# Agent Note: 「修改的文件」的接受记录改为会话级持久 store，并新增当前/全部视图

Status: implemented

## Problem

用户报告：「修改的文件」dock 里点击「全部接受」后，只要本会话后续还有文件变更，**此前已接受过的全部文件又一起回到列表**。触发场景经用户确认为刷新页面，以及切到别的会话再切回来。

根因不是列表的划分方式，而是接受记录的归属。接受集是 dock adapter 的组件本地 state（`SessionChangesDock.tsx` 的 `useState<AcceptedChanges>({})`）。按 `packages/client/AGENTS.md` 与 `packages/client/ui-renderer/src/client/scoped-slots.tsx` 的既有规则，组件本地状态在作用域重新绑定（rebind）时按构造清空，需要跨重挂载存活的状态必须放进 session 绑定的来源（store / hooks）。因此任何重挂载都会清空**全部**接受记录——这解释了用户看到的「全部文件一起回来」，而不只是新变更的那几个。

该行为当时被三处固化为「预期」：`session-changes-dock.client.spec.tsx` 的 `shows every change again after the dock remounts`、本包 README 的已知限制「无跨会话持久化」，以及[全会话投影 Agent Note](2026-09-14-session-changed-files-whole-log.zh.md) 的 D6「接受状态保持组件本地」。本次推翻该决策。

## Decision

**接受记录由会话作用域的持久化 store 持有。** `conversation.input.dock` 槽位已声明 `scope: 'session'`，在该条目注册时声明 `store` 后，框架按会话缓存实例（`ui-renderer` 的 `resolveStore`）：同一会话内重挂载复用同一实例，切换会话使用另一实例，会话消亡时 `clearStoreScope` 调用 `clearPersisted()` 清掉存储键，不留孤儿键。`defineStore` 的 `persist` 把会话 id 作为键后缀（`dsh.session-changes.accepted.<sessionId>`），因此每个会话独立持久化。这一条同时修掉刷新与切会话往返两条路径，即用户报告的全部触发场景。

**接受记录与两个视图，而不是两份物理列表。** 用户最初倾向「当前列表 + 历史列表」两份结构，接受时搬移。实现选择一份投影数据加一份接受记录，两个视图都由它们派生：

| 集合 | 定义 |
|---|---|
| 当前变更 | `accepted[path]` 缺失，或其 `lastSeq` 大于已接受的 seq |
| 全部变更 | 投影的全量已去重路径集 |

历史在数据上等于 `Object.keys(accepted)`，因此「接受时把文件从当前列表移到历史列表」在接受写入后由谓词变化自动成立，不需要搬移操作。行为与两份物理列表一致，但没有搬移代码，也就不存在「某路径同时漏在两边」或「历史里重复两条」这类不一致。去重由两处保证：路径唯一由 `accepted` 的 map 键保证，路径拼写唯一由宿主 `file-changes` 的 `canonicalMutationPath` 保证，两个视图共用同一份规范化路径。

**历史与当前允许重叠。** 历史定义为「曾被接受过」，不是「已接受且当前不再变更」。后者会把历史变成当前列表的补集，而用户描述的行为是：`file1.ts` 被接受后再变更时**两侧同时存在**，再次接受后才只剩全部视图侧且仍只有一条。`isPendingChange` 是这一比较的唯一归属方，`pendingChanges` 与行内接受控件都读它，避免规则被复述成两份。

**无待处理变更时 dock 仍然渲染。** 原实现在待处理为空时整块 `return null`。若保留，全部接受后「全部变更」的入口会随之消失，历史不可达。改为仅在 `changes.length === 0`（本会话从未变更过文件）时不渲染；有待处理时按原样展开，无待处理但有历史时收起为一行摘要。

## Alternatives considered

**维护两份物理列表并按事件搬移。** 否决：与「一份记录 + 派生视图」可观察行为完全相同，但需要自行维护两侧的去重与同步，而「同一路径同时出现在两处」或「两处都不在」的不一致正藏在这些搬移路径里。用户描述的四个步骤由派生式逐条复现，包括重叠那一步。

**单一列表，接受即移除。** 否决：字面实现会丢掉历史，正好砍掉用户想要的「查看全部变更」；而且列表真相源在宿主投影，客户端删不掉它，下次投影推送文件仍会回来，最终仍要靠一个标记过滤——即退化成派生式的弱化形式。

**只把接受记录放进 `hooks` 隔舱而不落 store。** 否决：`hooks` 隔舱面向「注册方私有的响应式事实」，其绑定按来源缓存、不随作用域存活；接受记录需要一个按会话存活且有界的可变集合，这正是 store 座的职责。

**冻结接受时刻的快照条目。** 用户确认只记路径。若历史行要显示「接受时是写入 / seq=10」，该信息无法从投影加接受记录推出，必须另存条目——这是双物理列表唯一不可替代的场景，本次不需要。

**持久化到宿主 settings。** 否决：刷新保持由 store 的 `persist` 机械完成，无需引入新的宿主持久化面与设置 namespace。

## Consequences

接受一个文件把它从「当前变更」隐藏，并在「全部变更」里保留为「已接受」行（不再提供接受按钮）；该文件此后被 agent 再次成功变更时回到「当前变更」，两个视图因此可能同时列出它。接受不动磁盘。记录跨 dock 重挂载、跨会话往返、跨页面刷新保持。

代价与已知边界：
- 记录随**会话作用域**存活，而作用域的生杀由 `ui-session` 的 eligibility 决定（当前选中，或仍列在 Host 上）。因此「切到别的会话再切回」保留记录——会话仍在列表里，作用域没死；而会话被移出列表后作用域连同持久化键一起被框架回收（`clearPersisted` 是防孤儿键的有意设计），该会话的记录不再恢复。
- 会话日志被修复或回滚后，同一路径的新变更若 `seq` 不大于已接受的 `seq`，会被判为已接受——比较是 seq 单调比较，不做内容比对。
- 持久化键是绝对路径，工作区被移动后旧标记失效，表现为文件重新出现。
- 接受记录随会话内被接受过的路径数有界增长（非事件级）。
- 一份新存储键进入了浏览器 localStorage。
- 面板在无待处理时仍渲染一行摘要，比原来「全部接受后整块消失」多占一行高度。
- 折叠状态与当前视图选择是组件本地状态，随组件重挂载复位：它们描述读者此刻的查看姿势，不是要跨会话保留的数据。

## Testing

- `packages/client/ui-session-changes/tests/accept-store-wiring.client.spec.tsx`（7 条）：在**真实装配**上验证接线——生产 `SlotRegistry`、`ui-session` scope adapter 与 renderer，配 `dsh-client-test-runtime` 的会话替身，挂载插件自身的 `apply`。其余 dock 测试都手工注入 `useStore`/`actions`，因此只有这一文件能证明框架确实解析了注册声明的 store 并交给组件。覆盖：解析出声明式会话作用域 store（`storeOf` 在条目未声明 store 时抛错，取到实例即是证明）、同一会话复用同一实例而不同会话各自独立、**切走再切回后记录仍在**（这是用户报告的主要触发场景）、会话被真正移除后随作用域丢弃实例与持久化键、持久化值写在 `dsh.session-changes.accepted.<会话 id>` 下、注册条目仍带 opener/order/字典，以及用框架解析出的实例驱动真实组件（点击接受写入该实例，重挂载后仍为已接受）。
- `packages/client/ui-session-changes/tests/session-changes-dock.client.spec.tsx`（52 条）：改写 `shows every change again after the dock remounts` 为 `keeps every accept when the dock remounts`（同一 store 实例重挂载后待处理仍为 0）；新增跨页面刷新保持（同一 handle 重建实例后仍为 0）、会话间独立、全部视图含已接受文件且已接受行不再提供接受按钮、**被接受路径再次变更时两个视图同时列出它且各只有一行**、再次接受后当前视图清空而全部视图仍只有一行、全部接受后 strip 仍可达且批量按钮消失、从未变更时不渲染、`isPendingChange` 单一谓词。dock 用例通过框架自己的 `bindSnapshotSelector` 绑定真实 store 实例，因此 shipped 的 persist 键与写入集都被覆盖。
- `packages/client/ui-session-changes/tests/e2e-business.client.spec.tsx`（3 条）：真实 Session 日志 → 真实 `changedFiles` 投影单元 → 真实 dock 组件。全部接受后先在全部视图核对两个文件仍可达，再编辑其中一个，断言只有它回到当前视图、另一个不出现。
- 两个测试文件各自 `beforeEach` 清 localStorage：store 会持久化，残留值会跨用例播种下一个实例。
- 该包 62 项通过；`tsc -p packages/client/ui-session-changes/tsconfig.json --noEmit` 干净；`oxlint` 0 警告 0 错误；`verify-client-packages` 与 `verify-client-ui-i18n` 通过；`src/**` 行覆盖 100%。
- 未跑 `test:web`（需要全仓库 build 与浏览器）。

## Deferred

- **拒绝 / 回滚仍不在范围内。** 不存在逐调用的先前内容快照可用于回滚。
- **不冻结接受时刻的快照。** 历史行展示该路径的当前状态；若要展示「接受时是什么样」，需要另存条目。
- **只认第一方变更工具。** 模型通过 `bash` 或脚本改动的文件不会被列出；判定归 `dsh-file-changes`。

## Related

- [全会话投影 Agent Note](2026-09-14-session-changed-files-whole-log.zh.md) — 数据源与 `(路径, lastSeq)` 接受比较的归属方；其 D6 与 Deferred 中的「接受状态不跨刷新」由本笔记取代。
- [变更列表路径 Agent Note](2026-09-08-session-changes-dock-paths.zh.md) — 行内路径拼写与打开行为。
