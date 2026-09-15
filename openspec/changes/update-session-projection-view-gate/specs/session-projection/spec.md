# session-projection 规范增量

## ADDED Requirements

### Requirement: 变更流以原始 view 引用为发布闸门

`SessionProjectionRegistry` 的 live drive SHALL 在 state 引用变化后计算单元的原始 `wire.view` 结果，并仅在该结果相对前一状态的原始结果按 `Object.is` 判定为变化时，才向变更流监听器发布经 `wire.viewSchema` 校验的值。比较 MUST 发生在 schema 校验之前，比较对象 MUST 是 `view` 的原始返回结果。

每个 cell SHALL 保留 `[previousView, currentView]` 两个槽位作为比较基准；槽位为 `undefined` 时 MUST 视为尚无缓存比较基准，该次变化 MUST 发布。

#### Scenario: 内部状态变化而 view 引用不变时不发布

- **WHEN** 一个单元的 state 引用发生变化，但 `wire.view` 对前后两个状态返回同一个对象引用
- **THEN** 变更流 SHALL NOT 为该事件调用任何监听器
- **AND** SHALL NOT 为该事件调用 `wire.viewSchema.parse`

#### Scenario: 原始 view 引用变化时发布校验后的值

- **WHEN** 一个单元的 state 引用发生变化，且 `wire.view` 对前后两个状态返回不同引用的结果
- **THEN** 变更流 SHALL 以 `wire.viewSchema.parse` 校验后的值调用每个监听器
- **AND** SHALL 传入致因事件的 seq
- **AND** 后续比较 SHALL 以该次变化的原始 view 结果为新基准

#### Scenario: 冷 cell 的首个变化必定发布

- **WHEN** 一个 cell 此前从未观察过任何 view
- **THEN** 其比较槽位 SHALL 为 `undefined`
- **AND** 该 cell 的首个 state 引用变化 SHALL 向监听器发布

### Requirement: 无监听器时不计算 view

当变更流没有任何监听器时，live drive SHALL NOT 调用 `wire.view`，也 SHALL NOT 调用 `wire.viewSchema.parse`。该路径 MUST 不产生任何分配。

#### Scenario: 无监听器时 view 不被调用

- **WHEN** 一个已注册单元声明了 `wire`，且变更流没有监听器
- **THEN** 该单元发生 state 引用变化时 SHALL NOT 调用 `wire.view`
- **AND** 该次变化的比较槽位 SHALL 置为 `undefined`

#### Scenario: 监听器加入后的首个变化必定发布

- **WHEN** 监听器在若干次未被观察的 state 变化之后订阅变更流
- **THEN** 该监听器观察到的下一个 state 引用变化 SHALL 被发布
- **AND** SHALL NOT 因先前未观察的变化而被抑制

#### Scenario: 监听器全部退订后不保留陈旧基准

- **WHEN** 最后一个监听器退订，此后单元发生若干次 state 引用变化，随后新监听器订阅
- **THEN** 新监听器 SHALL 收到下一个 state 引用变化产生的发布
- **AND** 发布的值 SHALL 为该变化之后状态的投影

### Requirement: 追赶历史不污染比较基准

`advanceCell` 追赶中间事件时 SHALL NOT 让未被观察的 view 成为比较基准。每遇 state 引用变化，该 cell 的比较槽位 MUST 被重置为「无基准」状态。

#### Scenario: 追赶期间的变化不抑制后续发布

- **WHEN** 一个 cell 落后于当前 seq，且 drive 需要先追赶若干中间事件
- **THEN** 追赶期间每个 state 引用变化 SHALL 将比较槽位重置为无基准
- **AND** 目标事件引发的 state 引用变化 SHALL 被发布

#### Scenario: 追赶不改变无变化事件的语义

- **WHEN** 追赶期间某个事件使 `apply` 返回同一 state 引用
- **THEN** 该事件 SHALL NOT 改变比较槽位

### Requirement: 对象 view 的引用复用契约

`ProjectionDefinition.wire.view` 的契约 SHALL 要求：对象或数组形态的 view 若要在仅内部 state 变化时抑制发布，就必须对等价内容复用引用。返回结构相同但引用不同的新对象 MUST 被判定为变化。该契约 SHALL 记录在 `wire.view` 的 JSDoc 与包 README 中。

#### Scenario: 复用引用的 view 保持安静

- **WHEN** 一个单元的 `view` 在仅内部工作字段变化时返回缓存的对象引用
- **THEN** 变更流 SHALL NOT 发布
- **AND** 该单元 SHALL 能把工作字段缓冲在 state 中而不影响下游

#### Scenario: 返回等价新对象的 view 视为变化

- **WHEN** 一个单元的 `view` 每次调用都返回内容相同但引用不同的新对象
- **THEN** 每次 state 引用变化 SHALL 发布一次
- **AND** 该行为 SHALL 被 README 记录为需要复引用才能保持安静的契约

### Requirement: snapshot 与冷读独立于变更流闸门

`snapshot()`、`checkpoint()` 与冷读 SHALL 继续执行完整的 view 计算与 schema 校验，MUST NOT 受比较槽位或发布历史影响。

#### Scenario: snapshot 不因未发布而返回陈旧值

- **WHEN** 若干次 state 变化因 view 引用不变或缺少监听器而未被发布
- **THEN** `snapshot()` SHALL 返回当前状态的投影值
- **AND** 其 `asOfSeq` SHALL 反映该单元的水位

### Requirement: 槽位推进在所有组合下自洽

实现 SHALL 附带穷举转移矩阵测试，覆盖状态转移序列、view 身份序列、比较基准是否已知、以及监听器掩码的组合，断言计算出的 view 身份序列与通知 seq 序列完全匹配。

#### Scenario: 穷举矩阵断言身份与通知序列

- **WHEN** 穷举测试枚举状态转移、view 身份、基准已知与否与监听器掩码的组合
- **THEN** 每个组合计算出的 view 身份序列 SHALL 与期望一致
- **AND** 通知的 seq 序列 SHALL 与期望一致

#### Scenario: 监听器断层与基准未知的组合被覆盖

- **WHEN** 监听器在序列中途加入或退出，且比较基准处于未知状态
- **THEN** 重订阅后的首个变化 SHALL 被发布
- **AND** 该行为 SHALL 由矩阵中的对应组合断言

### Requirement: 契约描述在生成产物中同步

`packages/extensions/tool-cordis/src/api-catalog.ts` 中 `sessionProjections` 服务条目与 `onChanged` 方法的契约描述 SHALL 反映两层闸门语义：state 引用不变时跳过 view 工作，原始 view 引用不变时抑制发布。该文件 SHALL NOT 用官方版本整段覆盖，MUST 保留本地 fork 内容。

因本地生成器存在未登记服务而失败，本次对该文件的改动 SHALL 以定点修改字符串常量完成。

#### Scenario: 服务描述反映两层闸门

- **WHEN** 检查生成产物中 `sessionProjections` 条目的 `description`
- **THEN** 该描述 SHALL 说明变更流仅在原始 view 结果按 `Object.is` 变化时通知
- **AND** SHALL NOT 再声明「视图按状态对象身份备忘」

#### Scenario: 本地 fork 内容不被覆盖

- **WHEN** 更新生成产物
- **THEN** 本地 fork 独有的条目 SHALL 保持存在
- **AND** SHALL NOT 用官方版本整段替换该文件
