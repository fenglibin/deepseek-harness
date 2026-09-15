# 用原始 view 身份闸门取代投影的逐事件发布

## 为什么

本地 `SessionProjectionRegistry.drive()`（`packages/session/session-projection/src/index.ts`）对每个已提交事件的闸门只有一层：state 引用变化 + 声明了 `wire` + 存在监听器，就立刻调用 `wire.viewSchema.parse(wire.view(cell.state))` 并向所有监听器广播。这带来两个问题。

第一，无法表达「state 变了但对外呈现没变」。单元把工作字段缓冲在 state 里、而 `view` 只投影其中一部分时，每次内部变化都会产生一次下游广播，即使模型可见的投影内容完全相同。

第二，每次 state 变化都要重新计算一次原始 view。对于返回新对象的计算型 view，每个事件都会分配一个随即被丢弃的对象，广播之前没有任何机会发现它其实与上一个投影等价。

官方提交 `6f0daff1dd`（`fix(session-projection): compare observed live views`）把闸门从「state 引用」推进到「原始 view 引用」，并用 `UnitCell` 上的固定双槽承载比较基准。本变更移植该语义。

## 做什么

把变更流的两层 `Object.is` 闸门落到本地 `SessionProjectionRegistry`：

- `UnitCell` 新增 `readonly views: [unknown, unknown]`，语义为 `[previousView, currentView]`，`undefined` 槽位表示尚无缓存比较基准
- `drive()` 在 state 引用变化时推进槽位：`views[0] = views[1]`，再计算 `views[1] = wire.view(next)`
- 仅当 `!Object.is(views[0], views[1])` 时才做 `viewSchema.parse` 并广播
- **无监听器时根本不调用 `view`**，槽位置 `undefined`，安静路径零分配
- `advanceCell()` 追赶历史时，每遇 state 引用变化就清空槽位，避免用陈旧基准比较
- 三处 cell 构造点（惰性注册、restore 播种、buildCell）初始化 `views: [undefined, undefined]`

## 不做什么

- 不引入按状态对象身份记忆化的 `WeakMap`：那是官方 `12bef3b577` 的方案，已被 `6f0daff1dd` 移除；本地分叉点从未包含它，移植只需新增双槽，无需撤销任何东西
- 不引入单元自声明的 `viewKey` 变更令牌（官方 `acc23f6d9c` 引入后已被 `a2437db180` 回退）
- 不给 `snapshot()`、`checkpoint()` 与冷读加视图缓存：它们保持彼此独立的完整读取
- 不改 `wire.viewSchema.parse` 的校验位置与时机
- 不把「上一次交付的值」存进 cell：那正是双槽方案要避免的、会在监听器换代期间过期的记录
- 不引入 `SessionSeq` 品牌类型等官方后续提交携带的无关重构

## 影响

- `packages/session/session-projection/src/index.ts`：`UnitCell`、三处 cell 构造、`drive()`、`advanceCell()`、相关 JSDoc
- `packages/session/session-projection/src/invariant.ts`：无运行时不变式需要改，仅注释中「一层闸门」的措辞需同步为「state/view 两层闸门」
- `packages/session/session-projection/README.zh.md`：设计理念与「已知限制」段落中的闸门描述
- `docs/subsystems/session-projection.zh.md`：驱动与变更流描述
- `packages/extensions/tool-cordis/src/api-catalog.ts`：由源码 JSDoc 生成，必须经 `pnpm run gen-cordis-catalog` 重新生成
- `packages/session/session-projection/tests/registry.spec.ts`：新增双槽语义的用例，并移植官方子提交 `9ba9a35c72` 的穷举转移矩阵
- `packages/api/session-controller/tests/session-projections.host.spec.ts`：改一处 `it` 名称与加一行注释（**不得整文件覆盖**，本地已有 36 行 fork 改动）

移植基准锁定在 `6f0daff1dd` 提交版本，**不是官方 master**：master 依赖本地未移植的品牌类型（`SessionSeqCursor` / `SessionSeq` / `cursorBefore()`）、`init(header, inheritedEventCount)` 二参签名与 `snapshotEvents()` / `eventAt()`。分叉点到该提交之间该文件经历 8 个提交、净 +39/−17，故移植净 diff 而非逐个重放。

以下本地文件已有 fork 改动，只能定点编辑：`README.zh.md`（已删英文切换行）、`docs/subsystems/session-projection.zh.md`（已含 `session-projection-cache.remove(id)` 条目）、`session-projections.host.spec.ts`（36 行 fork 改动）。

`wire.view` 的对象身份成为跨边界契约的一部分：对象或数组 view 若要在内部状态变化时保持安静，就必须复用引用。这属于结构契约变更（l2）。
