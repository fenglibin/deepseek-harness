# 技术决策

移植目标为官方提交 `6f0daff1dd`（`fix(session-projection): compare observed live views`）。本文件记录决策编号，供 tasks.md 锚定。

## 移植面基线

本地 `packages/session/session-projection/src/index.ts` 相对分叉点 `0a53fb55be` 只有 1 行差异（RFC 引用从 `.md` 改为 `.zh.md`），且该差异位于文件头注释。分叉点的 `UnitCell` 与 `drive()` 与官方提交的父版本在闸门语义上一致：一层 state 引用闸门，无原始 view 比较，无视图记忆化。

因此本变更的源码改动是**纯新增双槽**，不涉及撤销。官方 `12bef3b577`（按状态对象身份记忆化原始 view）在官方历史上是 `6f0daff1dd` 的直接父提交，但 `6f0daff1dd` 正是移除它的提交；本地从未包含它，文档与任务清单都不得把它当作实现依据。

### D1 双槽固定缓冲，而非按状态身份的记忆化

`UnitCell` 新增 `readonly views: [unknown, unknown]`，语义为 `[previousView, currentView]`，两个 `undefined` 槽位表示尚无缓存比较基准。

选固定双槽而非 `WeakMap<object, unknown>`：双槽只承载「上一状态」与「当前状态」两个比较值，其生命周期与 cell 相同，不需要按键查找，也不存在「条目是否正确」的推理。记忆化方案需要一条额外的正确性论据（条目是该确切状态的 view，因此永不过期），而该论据依赖 `view` 是纯函数这一未经机械把关的纪律。

### D2 双层 Object.is 闸门，第二层是发布闸门

第一层闸门在 state 引用不变时跳过全部 view 工作（沿用既有语义，`apply` 对无关事件必须返回同一引用）。第二层闸门在原始 `wire.view` 结果按 `Object.is` 不变时抑制发布。

关键点：比较发生在 `wire.viewSchema.parse` **之前**，比较的是**原始**结果而非校验后的值。校验后的值已经过 `zod` 的转换与克隆，其身份不再反映 view 函数的返回身份，无法用作闸门依据。

### D3 无监听器时不调用 view

当 `this.listeners.size === 0` 时，`drive()` 把 `views[1]` 置为 `undefined` 并**完全不调用** `wire.view(next)`。这使安静路径从「计算后丢弃」变为「零分配」。

代价是监听器从无到有时，第一个事件没有可比较的前值（`views[0]` 为 `undefined`），因此该事件的原始 view 会被无条件发布一次。这是正确行为：新监听器没有收到过任何值，其首个观察必须发布。同理，监听器全部退订期间发生的 state 变化不会留下陈旧基准——槽位被显式置为 `undefined`，退订后的第一个事件重新建立基准。

### D4 advanceCell 追赶时清空槽位

`advanceCell()` 在 `drive()` 之前把 cell 从 `observedSeq` 追赶至 `event.seq - 1`。这些中间事件的 view 从未被观察过，因此不能让它们推进比较槽位。做法是每遇 state 引用变化就执行 `views[0] = views[1]; views[1] = undefined`，即把「未观察」显式编码为 `undefined`。

不这么做的后果：一个 cell 在监听器存在期间经过中间事件追上目标 seq 时，`views[1]` 仍是若干事件之前的旧 view，可能与新 view 恰好同引用，从而错误地抑制一次本应发生的发布。

### D5 三处 cell 构造点统一初始化

`views` 是 `readonly` 字段，必须在构造时给出。本地三处构造点分别为：惰性注册（`register()` 的 cell 播种）、restore 的持久行播种、`buildCell()` 的日志折叠。三处一律初始化为 `[undefined, undefined]`，表示「本 cell 尚无任何被观察过的 view」。

统一初始值使「冷 cell 的首个变化必定发布」成为不依赖调用路径的性质。

### D6 对象 view 必须复用引用才保持安静

闸门按引用比较，因此 `view: state => ({ items: state.items })` 这类每次返回新对象的写法，即使内容相同也会判定为变化并发布。这是本变更引入的**对外契约**，必须写进 `ProjectionDefinition.wire.view` 的 JSDoc 与包 README：对象或数组 view 若要在仅内部 state 变化时抑制发布，就必须复用引用；结构相同的新对象仍算变化。

这条契约不是实现细节，而是单元作者必须知道的规则，因此它同时属于 spec 的行为要求。官方在 `packages/api/session-controller/tests/session-projections.host.spec.ts` 中为此加了一行注释（「相等的 payload 是新对象，因此 `Object.is` 仍视其 view 为变化」），说明它确实会让人意外。

### D7 移植基准是 `6f0daff1dd` 版本，不是官方 master

必须使用 `6f0daff1dd` 提交时的文件版本。官方 master 版本依赖三个本地尚未移植的能力：

- **品牌类型**：master 的 `observedSeq` 是 `SessionSeqCursor`，`advanceCell` 用 `SessionSeq()` 与 `cursorBefore()`。本地 `packages/core/session` 无 `SessionSeq` / `SessionLogOffset` / `SessionSeqCursor`，而 `6f0daff1dd` 版本仍用裸 `number`
- **`init(header, inheritedEventCount)` 二参签名**：`6f0daff1dd` 版本仍是 `init(header)`
- **`snapshotEvents()` 与 `eventAt()`**：本地无这两个方法，而 `session.events` getter 仍在（本地 `packages/core/session/src/index.ts:557`），`6f0daff1dd` 版本正好用 `session.events.slice(0, event.seq)`

官方从分叉点到 `6f0daff1dd` 之间该文件经历 8 个提交，净效果是 **+39/−17**。因此直接移植净 diff，而不是逐个重放这 8 个提交——重放会把品牌类型与二参签名一并带入，导致编译失败。

### D8 一并移植穷举转移矩阵测试

`6f0daff1dd` 的子提交 `9ba9a35c72`（`test(session-projection): cover view transition matrix`）给 `registry.spec.ts` 增加约 170 行穷举测试：状态转移序列 × view 身份序列 × 基准已知与否 × 监听器掩码的组合，断言 `computedViews` 的对象身份序列与通知 seq 序列完全匹配。

这是该闸门最强的正确性证据。双槽方案的正确性依赖「槽位推进」与「无监听器置空」在两个分支上的一致，逐例测试容易漏掉组合情形；穷举矩阵能在一次运行中覆盖全部组合。因此它与实现同批移植，而非留作后续。

本地 `registry.spec.ts` 当前不含该矩阵（已确认无 `four-state` / `baselineKnown` / `listenerMask` 相关标识）。

### D9 本地 fork 文件不可整文件覆盖

以下文件在本地已有 fork 改动，移植时只能定点编辑，绝不可用官方版本整段替换：

- `packages/session/session-projection/README.zh.md`：已删除英文切换行
- `docs/subsystems/session-projection.zh.md`：已含 `session-projection-cache.remove(id)` 条目
- `packages/api/session-controller/tests/session-projections.host.spec.ts`：已有 36 行 fork 改动，官方该提交只改一处 `it` 名称与加一行注释

### D10 api-catalog 当前无法经生成器刷新，只能定点改字符串

`packages/extensions/tool-cordis/src/api-catalog.ts` 是生成产物，本应经 `pnpm run gen-cordis-catalog` 刷新。**但本地生成器当前跑不通**：实测 `pnpm run verify-cordis-catalog` 报两个 partition violation 并以退出码 1 失败——`ctx.skillRoots`（`packages/skill/skill-filesystem/src/index.ts:129`）与 `ctx.mcpAuthSink`（`packages/mcp/mcp-client/src/connection.ts`）是本地 fork 独有的服务，未在 `SERVICE_PAGE` 或 `SERVICE_WALK_EXEMPTIONS` 中登记。

因此本变更对该文件只能**手工编辑字符串常量**，且 MUST NOT 用官方文件整段覆盖（本地已有 +290/−18 的 fork 改动）。需改两处：`sessionProjections` 服务条目的 `description` 字符串（移除「视图按状态对象身份备忘」一句，改为两层闸门描述）与 `onChanged` 的 `listener` 参数描述。

恢复生成能力需先为这两个服务决定 `SERVICE_PAGE` 映射，属于独立的文档基础设施修复，不在本变更范围内。

## 被拒绝的方案

**`WeakMap` 按状态对象身份记忆化原始 view**（官方 `12bef3b577`）：官方已在自己的下一个提交中移除。它引入一条依赖「view 是纯函数」的正确性论据，而该纪律在本地只有评审把关；双槽不依赖任何这类论据。且本地从未包含该代码，移植它等于主动引入一段官方已推翻的实现。

**保留「上一次交付的值」作为比较基准**：该记录会在监听器换代期间过期——旧监听器收到的最后一个值与新监听器的首个观察无关。双槽只存「上一状态的 view」与「当前状态的 view」，两者都是关于状态的，与谁在听无关。

**单元自声明 `viewKey` 变更令牌**（官方 `acc23f6d9c`）：要求每个单元作者额外提供一个令牌，把闸门正确性变成作者的义务；`Object.is` 闸门不需要新契约面。

**对 `snapshot()` 与冷读复用槽位**：`snapshot()` 是独立于变更流的完整读取，其语义是「当前全部值」，不应受「某个值是否被发布过」影响。官方实现同样让两者保持独立。

**在 `viewSchema.parse` 之后比较**：校验后的值是 `zod` 的输出，其身份不反映 view 函数的返回身份，无法作为闸门依据。

**照抄官方 master 版本的该文件**：master 依赖本地未移植的品牌类型（`SessionSeqCursor` / `SessionSeq` / `cursorBefore()`）、`init(header, inheritedEventCount)` 二参签名与 `snapshotEvents()` / `eventAt()`，会编译失败。移植基准锁定在 `6f0daff1dd`。

**逐个重放分叉点到 `6f0daff1dd` 之间的 8 个提交**：其中的中间提交引入品牌类型与签名变更，同样导致编译失败；净 diff 才是本变更的移植面。

**把穷举转移矩阵测试留作后续**：双槽正确性依赖两个分支的槽位推进一致，逐例测试容易漏掉组合情形，而该矩阵一次覆盖全部组合，成本低收益高。
