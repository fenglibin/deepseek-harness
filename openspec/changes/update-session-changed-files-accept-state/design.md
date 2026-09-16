# 技术决策

### D1 单一真相源 + 接受记录 + 派生视图，不建两份物理列表

记 F 为 changedFiles 投影的全量已去重路径集，A 为接受记录 path → 已接受的 seq：

| 集合 | 定义 |
|---|---|
| 当前变更 | A[p] 缺失 ‖ lastSeq > A[p] |
| 历史变更 | A[p] 存在（曾被接受过） |
| 全部变更 | F |

历史变更允许与当前变更重叠：file1.ts 被接受后再变更时两侧同时存在，再次接受后只剩历史侧并去重为 1 条。历史是"曾被接受过"，不是"已接受且当前不再变更"——后者会把它变成当前列表的补集，与用户描述的步骤不符。

在该定义下，历史在数据上等于 Object.keys(A)，用户描述的"接受时从当前列表移到历史列表"在接受写入后由谓词变化自动成立，不需要一次搬移操作：

| 场景 | 双物理列表要写的逻辑 | 单记录 + 派生视图 |
|---|---|---|
| 接受 | 历史加 p（去重）、当前删 p | A[p] = lastSeq |
| 新变更 | 当前加 p（去重）、历史不动 | 无需操作 |
| 再次接受 | 当前删 p、历史保持 1 条 | A[p] = lastSeq |
| 查看全部 | 两侧并集去重 | F |

两个视图的可观察行为与双物理列表完全相同，而右侧没有搬移代码，因此不存在"某路径同时漏在两边"或"历史里重复两条"这类不一致。去重由两处天然保证：路径唯一由 A 的 map 键保证，路径拼写唯一由宿主 packages/fs/file-changes/src/fold.ts 的 recordMutation/changedFilesView 保证，两个视图共用同一份规范化路径。

用户若将来需要冻结"接受时刻的快照"（历史行显示"接受时是写入/seq=10"），该信息无法从 F + A 推出，必须另存条目。本次按用户确认只记路径，不冻结快照。

否决：维护两份物理列表并按事件搬移（用户最初倾向）。行为等价但需自行维护去重与两侧同步，且"同一路径同时出现在两处"或"两处都不在"的不一致藏在这些搬移路径里。

### D2 接受集提升为 session 作用域 store 并持久化

conversation.input.dock 槽位已声明 scope: 'session'（packages/client/ui-conversation/src/client/contract/slots.ts:115）。在该条目注册时声明 store，框架按会话作用域缓存实例（packages/client/ui-renderer/src/client/registry.ts 的 resolveStore）：

- 同一会话内重挂载复用同一实例，接受记录保持；
- 切换到别的会话使用另一实例，互不干扰；
- 会话消亡时框架调用 clearPersisted() 清掉存储键，不留孤儿键（registry.ts 的 clearStoreScope）。

defineStore 的 persist 自动把会话 id 作为键后缀（packages/client/store/src/index.ts:222），因此每个会话独立持久化。这同时修掉刷新与切会话往返两条路径，即用户报告的全部触发场景。

否决：继续用组件本地 state 但放入 hooks 隔舱。hooks 隔舱面向"注册方私有的响应式事实"，其绑定按来源缓存、不随作用域存活；接受记录需要一个按会话存活且有界的可变集合，这正是 store 座的职责。

### D3 保留 pendingChanges 谓词，新增 historyChanges 与 allChanges

pendingChanges（SessionChangesDock.tsx:166）现有的 A[p] === undefined || lastSeq > A[p] 与本次目标语义一致，不需要修改。新增 historyChanges(changes, accepted) 返回 accepted[p] !== undefined 的条目，以及 allChanges（即入参全量）。三个读法都是纯函数，便于单测。

### D4 面板不再在无待处理变更时整块消失

SessionChangesPanel 现有实现于 pending.length === 0 时 return null（:207）。保留该行为会使全部接受后"查看全部变更"的入口一并消失，用户无法再看到历史。改为：有待处理条目时按现状展开；无待处理但存在历史条目时收起为一行摘要（含计数与视图入口）；从未有过变更时才不渲染。

### D5 持久化带来的三条已知边界

1. seq 回退：会话日志被修复或回滚后，同一路径的新变更若 seq 不大于已接受的 seq，会被判为已接受。接受规则是 seq 单调比较，不做内容比对。
2. 持久化键是绝对路径：工作区被移动后旧标记失效，表现为文件重新出现。
3. 接受记录随会话内被接受过的路径数增长（有界，非事件级）。

### D6 测试口径随之改写

tests/session-changes-dock.client.spec.tsx:539 的 shows every change again after the dock remounts 固化了本次要修掉的缺陷，改写为"重挂载后接受记录保持"。新增：跨刷新保留（同一 persist 键重建实例）、会话往返使用独立实例、接受后再变更两侧同时存在、再次接受后历史去重为 1 条、无待处理时仍可进入全部视图。