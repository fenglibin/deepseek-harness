# 交付纪律的可观测、可跟踪与可配置改造

## 为什么

现有交付纪律在四个点上与其设计意图不符，且这些偏差互相放大。

**分级误判的主因是编号列表规则，不是长度阈值。** `scanSignals` 把「3 条及以上编号项」直接计为一个 strong 命中，`gradeObjective` 又在 `strong > 0` 时返回 `l2`。实测一段仅 26 字符、不含任何信号词的文本 `"1、修复登录按钮\n2、修复注册按钮\n3、修复退出按钮"` 即被判为 `l2`；而本次改造的原始请求（410 字符）在 `specChars` 取 200、300、1200 三档下均判 `l2`，仅 600 档为 `l1` —— 即调高长度阈值并不能修正该误判。列出 3 条问题是提出需求最常见的写法，故该规则的误判面远大于阈值。

**l1 缺少确定性的产生路径。** `l2` 由 `agent/pre-step` 自动创建，`l1` 仅注入一次 rubric 提示交由模型自愿调用 `create_delivery_task`。模型不创建则不存在交付任务，左侧进度卡片亦不存在。

**任务列表存在三个会漂移的源。** `todos`（当轮，跨轮 `turn/start` 清空）、`delivery-tasks`（持久清单）、`openspec/.../tasks.md`（l2 的磁盘权威）。`DeliveryFloatCard` 的 `items.length === 0 ? todos ?? [] : []` 使 `delivery-tasks` 一旦有记录便不再读 `todos`，而 l1 下 `todo_write` 仍合法，故左侧卡片冻结在首次快照。`delivery-tasks` 投影已算出按阶段聚合的 `progress`，客户端一处未用。

**实现验证对 l1 空转、对 l2 仅形式检查。** `coverageGap()` 依赖 `openspec show <changeId> --json`，而 l1 的 `changeId` 是空串，命令必然非零退出并直接返回 `undefined`；对 l2 也只校验 `covers:` 注解是否指向已声明的点，不核验实现。任务若从未调用 `record_tasks`，检查因 `recorded === undefined` 整段放行。命令级验证（`openspec validate`、`postHooks`）位于 `accepted` 而非 `verified`。放行条件为一段 ≥20 字的自由文本，其轮次计数使用模块级 `Map`，跨会话互相污染。

**既有 change 的完成状态不可信。** `openspec/changes/add-delivery-openspec-split/tasks.md` 五组任务全部标记完成，但其 D3「双进度呈现」要求的按阶段展示子任务完成度在当前代码中并不存在。这正是本改造要解决的核心问题的直接证据：交付纪律自身无法保证其声明的完成度与实际代码一致。

## 做什么

1. **修正分级**：编号列表信号由 strong 降为 medium，使「可拆分」对应 `l1` 而非 `l2`；收窄强信号词表中的高频词；`l1` 判定后同样自动创建任务。
2. **统一任务源**：l1 任务存续期间监听 `todo/write` 并落持久 `delivery/tasks`，使 `delivery-tasks` 成为唯一权威源。
3. **重建实现验证**：`verified` 阶段改为按「原始需求 + 任务列表 + 设计文档」三类输入执行清单完整性、覆盖性、产物核验与逐条对账四道检查；命令级验证前移至 `verified`。
4. **轮次持久化**：验证复核轮次随任务记录，不再使用模块级计数器。
5. **配置界面**：扩展设置卡片的字段控件以支持布尔、枚举与词表，新增 `delivery` 命名空间的设置卡片。
6. **可观测**：进度面板按阶段分组展示 `done/total` 并标明权威源，提供常驻入口，展示分级判定依据；`LEVEL_PHASES` 合并为单一来源。
7. **修正 `enforcement: off`**：取消加载期与运行期的不一致。

## 不做什么

- 不把分级、分组执行、实现验证拆为三个独立包：三者共享同一份 `ResolvedConfig` 与同一套工具注册流程，拆包只带来形式边界而引入跨包契约与新的 capability seam。改为在 `tool-delivery` 内按模块分层，另加一个客户端设置卡片包。
- 不引入独立 verifier 子代理交叉验证：强度更高但增加模型成本与时延，留待按需追加。
- 不改动 `delivery/change` 与 `delivery/tasks` 的既有事件契约与 `delivery` 投影的严格字段白名单。

## 影响

- 编号列表规则降级后，此前被判 `l2` 的多条问题式需求将回到 `l1`，OpenSpec 四件套的产生频率下降，交付留痕相应变轻。
- `l1` 自动创建使交付任务覆盖所有非小微需求，左侧进度卡片在小微修复之外普遍出现。
- `verified` 的检查强度上升，此前可空转通过的验证将产生阻断，短期增加模型完成清单与对账的调用次数。
- 新增的持久 `delivery/tasks` 写入使 l1 的会话日志体积增加；沿用既有事件类型与严格解码器，不提升 `SESSION_FORMAT_VERSION`。
