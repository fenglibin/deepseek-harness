# client-keyed-hooks 规范增量

## ADDED Requirements

### Requirement: keyed 标准源合成为按 key 的选择器钩子

inject 面声明的 `keyedHooks` 分区 SHALL 在组件 props 上合成为 `use<Name>(key)` 形式的钩子。该钩子 SHALL 既可直接调用并返回当前值或 `undefined`，也可传入选择器与可选相等函数并返回所选值。

`hooks` 分区声明的源 SHALL 继续合成为 `PropsHooks`，其行为 SHALL NOT 因本次变更改变。

#### Scenario: keyed 源到达组件 props

- **WHEN** 一个 slot 注册的 inject 面声明了 `keyedHooks: { resource: resolver }`
- **THEN** 该组件 props SHALL 包含 `useResource`
- **AND** 以某个 key 调用它 SHALL 返回该 key 的当前值或 `undefined`

#### Scenario: 未声明 keyedHooks 的面保持不变

- **WHEN** 一个 inject 面只声明 `hooks` 或两者都不声明
- **THEN** 其 props 合成结果 SHALL 与本变更前完全一致

#### Scenario: 按 key 的选择器收窄重渲染

- **WHEN** 组件以选择器与相等函数调用 keyed 钩子
- **THEN** 只有所选值变化时该组件 SHALL 重新渲染
- **AND** 同一 keyed 源的其他 key 变化 SHALL NOT 触发该组件

### Requirement: 客户端资源以地址寻址

客户端 SHALL 提供 `ctx.resources` 服务，协议属主 SHALL 能为其协议注册一个提供方。地址 SHALL 采用 `dsh-resource://<protocol>/…` 形式，协议名 SHALL 是 URL 的 host 部分。

一个协议 SHALL 至多有一个提供方；重复注册 SHALL 抛错。

#### Scenario: 注册协议提供方

- **WHEN** 一个协议属主注册其提供方
- **THEN** 该协议 SHALL 可被解析
- **AND** 该注册 SHALL 随注册作用域的释放而撤销

#### Scenario: 重复注册同一协议被拒绝

- **WHEN** 两个提供方注册同一个协议
- **THEN** 第二次注册 SHALL 抛出错误

#### Scenario: 非资源地址不解析协议

- **WHEN** 传入的地址不是 `dsh-resource://` 形式的 URL
- **THEN** 其协议 SHALL 解析为 `undefined`

### Requirement: 资源快照有四种状态

`useResource(address)` SHALL 返回带 `status`、`value` 与 `failure` 的快照。`status` SHALL 取 `none`、`loading`、`live`、`failed` 之一。

#### Scenario: 无提供方时为 none

- **WHEN** 地址的协议没有注册提供方
- **THEN** `status` SHALL 为 `none`

#### Scenario: 有提供方但未产出首帧时为 loading

- **WHEN** 地址的协议有提供方且尚未收到第一帧
- **THEN** `status` SHALL 为 `loading`

#### Scenario: 收到成功帧后为 live

- **WHEN** 提供方产出一个成功帧
- **THEN** `status` SHALL 为 `live`
- **AND** `value` SHALL 是该帧的值

#### Scenario: 失败帧保留上一个值

- **WHEN** 提供方产出一个失败帧
- **THEN** `status` SHALL 为 `failed`
- **AND** `failure` SHALL 携带错误
- **AND** `value` SHALL 保留上一个成功的值

### Requirement: 资源持有者计数决定流的生命周期

资源 SHALL 在有持有者时保持打开。持有者 SHALL 包含订阅中的 `useResource` 调用与显式 `pin` 调用。第一个持有者 SHALL 开启提供方的流，最后一个释放时 SHALL 中止流并重置快照。

`source(address)` 返回的 observable SHALL 按地址保持引用稳定，即使记录已无持有者。

#### Scenario: 最后一个持有者释放时中止流

- **WHEN** 一个资源的最后一个持有者释放
- **THEN** 提供方的流 SHALL 被中止
- **AND** 快照 SHALL 重置为 `none` 或 `loading`

#### Scenario: pin 不产生订阅但保持资源打开

- **WHEN** 以 `pin(address, signal)` 持有一个资源
- **THEN** 该资源 SHALL 保持打开
- **AND** SHALL NOT 因该 pin 而增加订阅

#### Scenario: pin 的 signal 中止时释放

- **WHEN** 传入 `pin` 的 signal 被中止
- **THEN** 该持有 SHALL 被释放

#### Scenario: 来源引用跨重挂载保持稳定

- **WHEN** 一个地址的记录已无持有者，随后再次被订阅
- **THEN** `source(address)` SHALL 返回同一引用
