# 实施清单

移植目标为官方提交 `6f0daff1dd`。本地分叉点未包含 `12bef3b577` 的 `WeakMap` 记忆化，故本清单不含任何撤销步骤。

**移植基准锁定在 `6f0daff1dd` 版本，不是官方 master**：master 依赖本地未移植的品牌类型（`SessionSeqCursor` / `SessionSeq` / `cursorBefore()`）、`init(header, inheritedEventCount)` 二参签名与 `snapshotEvents()` / `eventAt()`。分叉点到 `6f0daff1dd` 之间该文件经历 8 个提交，净效果 +39/−17，因此移植**净 diff** 而非逐个重放。

## 1. 移植基准

- [ ] 1.1 以 `git diff 0a53fb55be 6f0daff1dd -- packages/session/session-projection/src/index.ts`（净 +39/−17）作为移植面，逐段核对本地上下文后应用；不得改用官方 master 版本，也不得逐个重放中间 8 个提交 (covers: session-projection/冷 cell 的首个变化必定发布, design/D7)

## 2. UnitCell 与双槽

- [ ] 2.1 在 `packages/session/session-projection/src/index.ts` 的 `UnitCell` 上新增 `readonly views: [unknown, unknown]`，并写明 JSDoc：`[previousView, currentView]`，`undefined` 槽位表示尚无缓存比较基准 (covers: session-projection/冷 cell 的首个变化必定发布, design/D1)
- [ ] 2.2 更新 `UnitCell` 的接口 JSDoc，从「水位缓存行」改为「水位与固定 live-drive 视图缓冲」 (covers: design/D1)
- [ ] 2.3 在三处 cell 构造点（`session/created` 钩子的惰性播种、restore 的持久行播种、`buildCell()` 的日志折叠）统一初始化 `views: [undefined, undefined]`；注意第一处位于构造函数注册的 `ctx.on('session/created', ...)` 内 (covers: session-projection/冷 cell 的首个变化必定发布, design/D5)

## 3. drive 的双层闸门

- [ ] 3.1 在 `drive()` 中把 state 引用变化判定改为先取 `previousState`，再算 `changed = !Object.is(next, previousState)`，并保持 `cell.state` 与 `cell.observedSeq` 的更新顺序不变 (covers: session-projection/内部状态变化而 view 引用不变时不发布, design/D2)
- [ ] 3.2 在 state 引用变化且声明了 `wire` 时推进槽位：`views[0] = views[1]`，随后仅在 `this.listeners.size > 0` 时计算 `views[1] = wire.view(next)` (covers: session-projection/原始 view 引用变化时发布校验后的值, design/D2)
- [ ] 3.3 仅当 `!Object.is(views[0], views[1])` 时执行 `wire.viewSchema.parse(views[1])` 并遍历监听器发布；比较必须在 parse 之前 (covers: session-projection/原始 view 引用变化时发布校验后的值, design/D2)
- [ ] 3.4 无监听器分支把 `views[1]` 置为 `undefined`，且该分支不得调用 `wire.view` (covers: session-projection/无监听器时 view 不被调用, design/D3)
- [ ] 3.5 保留「state 引用不变时保留当前 view 作为下一个变化的有效比较值」的注释语义，确认无变化事件不推进槽位 (covers: session-projection/监听器全部退订后不保留陈旧基准, design/D3)

## 4. advanceCell 的基准重置

- [ ] 4.1 在 `advanceCell()` 的追赶循环中，每遇 `!Object.is(next, cell.state)` 就执行 `views[0] = views[1]; views[1] = undefined`，把「未观察」显式编码为 `undefined` (covers: session-projection/追赶期间的变化不抑制后续发布, design/D4)
- [ ] 4.2 确认 `apply` 返回同一引用的事件不触碰槽位 (covers: session-projection/追赶不改变无变化事件的语义, design/D4)

## 5. 冷读路径与 JSDoc 契约

- [ ] 5.1 确认 `viewCell()` 与 `snapshot()` 保持「每次完整计算 + `viewSchema.parse`」，不受槽位影响；仅移除已无用的间接层，不引入任何缓存 (covers: session-projection/snapshot 不因未发布而返回陈旧值, design/D1)
- [ ] 5.2 在 `ProjectionDefinition.wire.view` 的 JSDoc 写明：live drive 保留最近两个原始结果并按 `Object.is` 比较，对象形态的 view 必须复用引用才能在仅内部状态变化时抑制发布 (covers: session-projection/复用引用的 view 保持安静, design/D6)
- [ ] 5.3 更新 `ProjectionChangeListener` 与 `onChanged()` 的 JSDoc，把触发条件从「state 引用变化」改为「原始 view 结果按 `Object.is` 变化」 (covers: session-projection/返回等价新对象的 view 视为变化, design/D6)
- [ ] 5.4 更新 `SessionProjectionRegistry` 的类级 JSDoc 驱动描述，说明两层闸门与「无监听器不计算 view」 (covers: session-projection/无监听器时 view 不被调用, design/D3)

## 6. 单元测试

- [ ] 6.1 用例：`apply` 返回同一 state 引用时跳过 view 工作且不发布 (covers: session-projection/内部状态变化而 view 引用不变时不发布, design/D2)
- [ ] 6.2 用例：无监听器时 `view` 不被调用（以调用计数断言），且后续订阅者的首个变化必定发布 (covers: session-projection/无监听器时 view 不被调用, session-projection/监听器加入后的首个变化必定发布, design/D3)
- [ ] 6.3 用例：state 变化而 view 引用不变时抑制发布，view 引用变化时以校验后的值发布 (covers: session-projection/原始 view 引用变化时发布校验后的值, design/D2)
- [ ] 6.4 用例：未观察的 state 变化之后的第一个 view 必定发布（冷基准语义） (covers: session-projection/冷 cell 的首个变化必定发布, design/D1)
- [ ] 6.5 用例：监听器退订期间发生 state 变化、随后重新订阅，不因陈旧基准而抑制发布 (covers: session-projection/监听器全部退订后不保留陈旧基准, design/D3)
- [ ] 6.6 用例：cell 追赶中间事件后，目标事件的发布不被抑制；追赶中同引用事件不改槽位 (covers: session-projection/追赶期间的变化不抑制后续发布, session-projection/追赶不改变无变化事件的语义, design/D4)
- [ ] 6.7 用例：返回等价新对象的 view 每次变化都发布，复用引用的 view 保持安静 (covers: session-projection/返回等价新对象的 view 视为变化, session-projection/复用引用的 view 保持安静, design/D6)
- [ ] 6.8 用例：若干次未发布的变化之后 `snapshot()` 仍返回当前投影与正确 `asOfSeq` (covers: session-projection/snapshot 不因未发布而返回陈旧值, design/D1)
- [ ] 6.9 用例：未经 `drive()` 的冷 cell 首次变化必定发布（覆盖三处构造点各自的初始值） (covers: session-projection/冷 cell 的首个变化必定发布, design/D5)
- [ ] 6.10 移植官方子提交 `9ba9a35c72` 的穷举转移矩阵测试（约 170 行）：枚举状态转移序列 × view 身份序列 × 基准已知与否 × 监听器掩码，断言 `computedViews` 的对象身份序列与通知 seq 序列完全匹配 (covers: session-projection/穷举矩阵断言身份与通知序列, design/D8)
- [ ] 6.11 确认矩阵覆盖监听器中途加入/退出且基准未知的组合 (covers: session-projection/监听器断层与基准未知的组合被覆盖, design/D8)
- [ ] 6.12 更新 `packages/api/session-controller/tests/session-projections.host.spec.ts`：改一处 `it` 名称为「broadcasts changed view references with the causing seq and skips same-reference applies」，并加一行注释说明「相等的 payload 是新对象，因此 `Object.is` 仍视其 view 为变化」；**不得整文件覆盖**（本地已有 36 行 fork 改动） (covers: session-projection/返回等价新对象的 view 视为变化, design/D9)

## 7. 文档

- [ ] 7.1 更新 `packages/session/session-projection/README.zh.md`：设计理念段落改为「第一层 state 引用闸门跳过 view 工作、第二层原始 view 引用闸门抑制发布」，并补上对象 view 必须复用引用的契约；**定点编辑，不得整文件覆盖**（本地已删英文切换行） (covers: session-projection/复用引用的 view 保持安静, design/D6)
- [ ] 7.2 更新 README 的「驱动与检查点流程」段落：发布条件改为「原始 view 按 `Object.is` 变化」，并说明 live drive 保留前后两个原始 view、snapshot 与冷读仍是独立完整读取 (covers: session-projection/snapshot 不因未发布而返回陈旧值, design/D1)
- [ ] 7.3 更新 README 的「已知限制与延期工作」段落，把「同引用闸门」改为「state/view 引用闸门」 (covers: design/D2)
- [ ] 7.4 更新 `docs/subsystems/session-projection.zh.md` 中变更流与驱动章节；**定点编辑，不得整文件覆盖**（本地已含 `session-projection-cache.remove(id)` 条目） (covers: session-projection/原始 view 引用变化时发布校验后的值, design/D9)
- [ ] 7.5 更新 `packages/session/session-projection/src/invariant.ts` 的注释，把「Object.is 变更闸门」改为「state/view 两层 `Object.is` 闸门」；无运行时不变式变更 (covers: design/D2)

## 8. 生成产物与收尾

- [ ] 8.1 确认 `pnpm run gen-cordis-catalog` 当前因 `ctx.skillRoots` 与 `ctx.mcpAuthSink` 两个未登记服务而失败（实测退出码 1，2 个 partition violation），因此本变更对该文件只能定点改字符串 (covers: session-projection/本地 fork 内容不被覆盖, design/D10)
- [ ] 8.2 定点修改 `packages/extensions/tool-cordis/src/api-catalog.ts` 中 `sessionProjections` 条目的 `description`：移除「视图按状态对象身份备忘」表述，改为「state 引用变化时计算下一个 client view，变更流仅在原始结果按 `Object.is` 变化时通知」 (covers: session-projection/服务描述反映两层闸门, design/D10)
- [ ] 8.3 定点修改该文件中 `onChanged` 的 `listener` 参数描述为「每个已提交事件中原始 view 按 `Object.is` 变化的 client-visible 单元」 (covers: session-projection/服务描述反映两层闸门, design/D10)
- [ ] 8.4 逐条比对确认本地 fork 独有内容（+290/−18 改动）保持存在，绝不用官方文件整段覆盖 (covers: session-projection/本地 fork 内容不被覆盖, design/D10)
- [ ] 8.5 记录后续工作项：为 `ctx.skillRoots` 与 `ctx.mcpAuthSink` 决定 `SERVICE_PAGE` 映射或加入 `SERVICE_WALK_EXEMPTIONS`，以恢复 `gen-cordis-catalog` 与 `verify-cordis-catalog`；该项属于独立的前置修复，不在本变更范围 (covers: design/D10)
- [ ] 8.6 新增 Agent Note 记录双槽语义与「无监听器不计算 view」的决策依据，并说明为何拒绝按状态身份记忆化 (covers: design/D1, design/D3)
