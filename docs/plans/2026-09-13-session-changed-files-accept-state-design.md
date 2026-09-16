# 「修改的文件」dock 接受状态改造设计

## 问题

用户报告：在对话输入框上方的「修改的文件」列表中点击「接受」或「全部接受」后，只要本会话后续还有文件变更，**此前已接受过的全部文件又一起回到列表**。

诊断结论：这不是列表划分方式的问题，而是接受记录的归属问题。

`SessionChangesDock` 的接受集是组件本地 state（`packages/client/ui-session-changes/src/client/SessionChangesDock.tsx:298` 的 `useState<AcceptedChanges>({})`）。按 `packages/client/AGENTS.md` 与 `packages/client/ui-renderer/src/client/scoped-slots.tsx` 的既有规则，组件本地状态在作用域切换时**按构造清空**，需要跨重挂载存活的状态必须放进 session 绑定的来源（store / hooks）。

因此任何导致 dock 适配器重挂载的事件都会清空全部接受记录，于是**所有**文件一起回到待处理——这正好解释了用户观察到的"全部变更的文件又出现"，而不只是新变更的那几个。用户已确认触发场景为「刷新页面」与「切到别的会话再切回来」。

该现象已被现有测试固化为预期行为（`packages/client/ui-session-changes/tests/session-changes-dock.client.spec.tsx:539` 的 `shows every change again after the dock remounts`），并被 README 已知限制第 4 条「无跨会话持久化」记录。前身变更 `openspec/changes/add-session-changed-files-log` 的 D6 也明确写了"接受状态保持组件本地，不持久化"——本次推翻该决策。

## 语义（经用户确认）

记 `F` 为 `changedFiles` 投影中的全量已去重路径集，`A` 为接受记录 `path → 已接受的 seq`：

| 集合 | 定义 |
|---|---|
| 当前变更 | `A[p] 缺失 ‖ lastSeq > A[p]` |
| 历史变更 | `A[p] 存在`（**曾被接受过**） |
| 全部变更 | `F` |

关键点：**历史变更允许与当前变更重叠**。`file1.ts` 被接受后再变更时，它同时出现在两侧；再次接受后才只剩历史侧（去重为 1 条）。历史定义为"曾被接受过"而非"已接受且当前不再变更"，后者会把它变成当前列表的补集，与用户描述的四个步骤不符。

同时 `当前 ∪ 历史 = F` 恒成立：任一文件要么没被接受过（必在当前），要么被接受过（必在历史）。

## 决策

### D1 单一真相源 + 接受记录 + 派生视图，不建两份物理列表

「历史变更列表」在数据上等于 `Object.keys(A)`。用户描述的"接受时从当前列表移到历史列表"，在接受写入 `A[p] = lastSeq` 之后由谓词变化**自动成立**，不需要一次搬移操作：

| 场景 | 双物理列表要写的逻辑 | 单记录 + 派生视图 |
|---|---|---|
| 接受 | 历史加 `p`（去重）、当前删 `p` | `A[p] = lastSeq` |
| 新变更 | 当前加 `p`（去重）、历史不动 | 无需操作 |
| 再次接受 | 当前删 `p`、历史保持 1 条 | `A[p] = lastSeq` |
| 查看全部 | 两侧并集去重 | `F` |

右侧没有搬移代码，因此不存在"某路径同时漏在两边"或"历史里重复两条"这类不一致。去重由两处天然保证：路径唯一由 `A` 的 map 键保证，路径拼写唯一由宿主 `packages/fs/file-changes/src/fold.ts` 的 `recordMutation`/`changedFilesView`（canonical path）保证，两个视图共用同一份规范化路径。

可观察行为与双物理列表完全相同。用户若将来需要冻结"接受时刻的快照"（例如历史行显示"接受时是写入/seq=10"），则该信息无法从 `F + A` 推出，必须另存条目——本次按用户确认只记路径，不冻结快照。

### D2 接受集提升为 session 作用域 store，并持久化

`conversation.input.dock` 槽位已声明 `scope: 'session'`（`packages/client/ui-conversation/src/client/contract/slots.ts:115`）。在该条目注册时声明 `store`，框架按会话作用域缓存实例（`packages/client/ui-renderer/src/client/registry.ts` 的 `resolveStore`），因此：

- 同一会话内重挂载复用同一实例，接受记录保持；
- 切换到别的会话使用另一实例，互不干扰；
- 会话消亡时框架调用 `clearPersisted()` 清掉存储键，不留孤儿键（`registry.ts` 的 `clearStoreScope`）。

`defineStore` 的 `persist` 会自动把会话 id 作为后缀（`packages/client/store/src/index.ts:222`），因此每个会话独立持久化。

### D3 保留 `pendingChanges` 谓词，新增 `historyChanges`

`pendingChanges`（`SessionChangesDock.tsx:166`）的语义与本次目标一致，**不需要修改**。新增一个 `historyChanges` 读取 `A` 的键集合，并新增 `allChanges` 视图（即全量）。

### D4 面板不再在无待处理时整块消失

现有 `SessionChangesPanel` 在 `pending.length === 0` 时 `return null`（`:207`）。若保留该行为，全部接受后连"查看全部变更"的入口都会消失，用户无法再看到历史。因此改为：无待处理时收起为一行摘要（含计数与视图入口），仅在列表为空（从未有变更）时才不渲染。

### D5 已知限制的边界

1. **seq 回退**：会话日志被修复或回滚后，同一路径的新变更若 `seq` 不大于已接受的 `seq`，会被判为已接受。接受规则是 seq 单调比较，不做内容比对。
2. **持久化键是绝对路径**：工作区被移动后旧标记失效，表现为文件重新出现。
3. **接受记录随会话内被接受过的路径数增长**（有界，非事件级）。

## 影响面

- `packages/client/ui-session-changes/src/client/SessionChangesDock.tsx`：接受集来源、视图切换、面板收起。
- 新增 `packages/client/ui-session-changes/src/client/accept-store.ts`：store 声明。
- `packages/client/ui-session-changes/src/client/locales.ts`：视图文案。
- `packages/client/ui-session-changes/src/client/SessionChangesDock.module.css`：视图切换样式。
- `packages/client/ui-session-changes/src/client/index.ts`：注册时声明 store。
- 测试、README、Agent Note。

不改动：宿主 `changedFiles` 投影、会话日志格式、工具语义、磁盘内容。接受仍是纯界面行为。
