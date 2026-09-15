# Agent Note: 会话投影的变更流以原始 view 引用为闸门

Status: implemented

## Problem

变更流原先以**单元状态**变化为闸门：`apply` 返回新状态引用就越过 `wire.view` 计算视图，并通知每个监听器。这对"状态随每个事件都变、但对外可见值不变"的单元会产生无意义的发布——例如一个内部只记录修订号或折叠进度的单元，其对外值是同一份数据。

两个具体后果。第一，监听器收到重复的相同值，接收方必须自行去重；第二，无监听器时也照样计算视图，而那是一项纯浪费的工作（`wire.view` 可能分配对象）。

状态闸门也无法表达"这个单元这次是否真的要发布"：状态是新引用不代表对外值是新值。

## Decision

`UnitCell` 增加一个固定双槽 `readonly views: [unknown, unknown]`，语义是 `[上一份原始 view, 当前原始 view]`。`drive` 的闸门分两层：

第一层仍是状态引用比较（`Object.is(next, previousState)`）——状态没变就完全不碰视图，保持既有的零下游工作特性。状态变了才把 `views[1]` 挪进 `views[0]`，然后只在**存在监听器**时调用 `wire.view(next)` 写入 `views[1]`；无监听器时把 `views[1]` 置为 `undefined`，**完全不调用 `view`**，做到零分配。

第二层是原始 view 引用比较：只有 `!Object.is(views[0], views[1])` 时才用 `viewSchema.parse` 校验并通知监听器。因此"结构相同的新对象仍算变化"，而"复用同一个引用的对象 view 在仅内部状态变化时保持安静"。

槽位在三处初始化为 `[undefined, undefined]`（`session/created`、`hydrate` 写回、`buildCell`），使首帧必定发布。`advanceCell` 的折叠循环里也做同样的槽位推移——冷推进跨过若干事件折叠历史时，若不作废 `views[1]`，`drive` 会拿到一个已被折叠掉的状态的视图，产生误抑制。

`viewCell` 保持不变（仍是"每次重算"），它服务 `snapshot`、`cachedSnapshot` 与 `hydrate` 这些独立于变更流的完整读取。

## 曾考虑的替代方案

**按状态引用做 WeakMap 记忆化视图。** 曾在同一位置引入过（`viewMemo` 表加 `viewOf` 方法），随后被本方案替换。理由：`drive` 手上同时握着 previous 与 next，双槽缓存只需把上一次算出的原始 view 挪一格，不需要任何记忆化契约；而 WeakMap 方案要同时为 previous 与 next 各查一次表，且依赖"该状态当时被算过"这一隐式前提。双槽方案还顺带表达了"上一次发布值"这一语义。

**只比较状态引用，不比较视图引用。** 不予采用：这正是要修的问题——状态随事件变化而对外值不变的单元仍会重复发布。

**无监听器时也算视图并缓存。** 不予采用：无消费者时计算视图是纯浪费，且会让 `views[1]` 落在一个无人读取的值上。

**让监听器自行去重。** 不予采用：把契约成本推给每个接收方，且实现方容易漏做。

## Consequences

收益：只有对外值真正变化的单元才发布，监听器不再收到重复值；无监听器时视图计算完全消失。对象或数组 view 若不复用引用就会每次发布——这是显式契约，已写入 `ProjectionDefinition.wire.view` 的 JSDoc 与包 README。

代价：单元作者必须理解引用语义。返回结构相同的新对象会被判定为变化；要在仅内部状态变化时保持安静，就必须复用引用。这一约束无法机械化把关，只能靠评审。

该实现依赖 Vitest/Vite 之外的运行时次序没有变化：`drive` 内两层的顺序（先比状态、再比视图）是语义的一部分，不可调换。

## Testing

`packages/session/session-projection/tests/registry.spec.ts` 新增三条用例：无监听器时 `view` 不被调用；首次发布的视图被送出、后续同引用视图被抑制（并断言 `view` 的调用次数只随真实变化增长）；监听器断层后重订阅时首个变化必定发布。

`packages/api/session-controller/tests/session-projections.host.spec.ts` 的用例名与一处注释同步更新，说明"相同载荷是新对象，因此 `Object.is` 仍视为变化"。
