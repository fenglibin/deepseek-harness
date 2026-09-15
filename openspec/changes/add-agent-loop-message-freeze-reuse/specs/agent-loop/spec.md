# agent-loop 规范增量

## ADDED Requirements

### Requirement: 按循环实例复用已证明的消息冻结

`ReactLoopAgent` SHALL 持有一个私有的消息身份证明集合，其中只记录该实例中完整深冻结调用成功的 `Message` 对象身份。构造请求时，对已在证明集合中的消息 MUST 跳过深冻结；对不在集合中的消息 MUST 执行深冻结，且仅在成功后才将其加入集合。

证明集合 MUST 使用弱引用，MUST NOT 延长被替换消息的生命周期。

#### Scenario: 重复请求不重复遍历已证明的历史

- **WHEN** 同一循环连续构造两个包含相同 `Message` 对象的请求
- **THEN** 第二个请求 SHALL NOT 对这些消息重新执行深冻结
- **AND** 第二个请求的 `messages` SHALL 仍包含这些同一批对象

#### Scenario: 首次出现的消息被深冻结

- **WHEN** 一个循环遇到此前未见过的 `Message` 对象
- **THEN** 该对象 SHALL 被深冻结
- **AND** 其全部后代 SHALL 被冻结
- **AND** 其身份 SHALL 在成功后进入证明集合

#### Scenario: 新循环为恢复的历史重新证明

- **WHEN** 一个新循环接管由恢复得到的消息历史
- **THEN** 该循环 SHALL 为这些消息重新执行深冻结
- **AND** SHALL NOT 因消息 id 相同而跳过

### Requirement: 证明只记录成功完成的遍历

深冻结遍历失败的消息 MUST NOT 进入证明集合。后续请求 MUST 对这类消息重新尝试冻结。

#### Scenario: 遍历失败的身份被重试

- **WHEN** 一个消息对象的首次深冻结遍历失败
- **THEN** 该身份 SHALL NOT 进入证明集合
- **AND** 下一次请求 SHALL 对该消息重新尝试深冻结

### Requirement: 不可变性证明不依赖 Object.isFrozen

判定一个消息是否已可复用时，实现 MUST 依据本循环的遍历证明，MUST NOT 依据 `Object.isFrozen` 的返回值，也 MUST NOT 依据消息 id 相等。

#### Scenario: 浅冻结的恢复根对象不被当作已证明

- **WHEN** 恢复得到的消息根对象已冻结但持有可变后代
- **THEN** 该消息 SHALL NOT 被视为已证明
- **AND** 其可变后代 SHALL 在请求构造时被冻结

#### Scenario: 保留 id 的替换不被误判为同一对象

- **WHEN** 一个消息被替换为 id 相同但对象身份不同的新消息
- **THEN** 新对象 SHALL NOT 命中证明集合
- **AND** SHALL 被深冻结

### Requirement: 请求各面的冻结面显式区分

构造请求时，本地规范化 header、每条消息、消息数组与请求封装 SHALL 各自被冻结。`AbortSignal` MUST 保持可变，实时取消能力 MUST NOT 被改变。`markAgentLoopRequest` MUST 继续标记该请求。

#### Scenario: 本地 header 每次请求都被冻结

- **WHEN** 一个请求被构造
- **THEN** 其本地规范化 header SHALL 被深冻结
- **AND** 其 `tools` 数组与 `NO_ADAPTER` 回退路径中的 stop 数组 SHALL 不可变

#### Scenario: 实时取消在分发后仍可观察

- **WHEN** 请求已分发给适配器，随后其信号被中止
- **THEN** 该请求的 `signal` SHALL 反映中止状态
- **AND** 该信号对象 SHALL NOT 被冻结

#### Scenario: 请求标记保留

- **WHEN** 一个请求被构造
- **THEN** 该请求 SHALL 携带 `markAgentLoopRequest` 设置的标记

### Requirement: 消息身份跨请求稳定

`Session.deriveMessages()` SHALL 在多次调用间共享同一批 `Message` 对象：数组可以是新快照，元素 MUST 是已缓存的同一批对象。该性质 SHALL 由测试断言覆盖，因为它是冻结复用的前提。

#### Scenario: 连续两次派生返回同一批消息对象

- **WHEN** 在同一 surface 状态下连续调用两次 `deriveMessages()`
- **THEN** 两次返回的数组 SHALL 元素数量相同
- **AND** 对应位置的 `Message` SHALL 满足 `Object.is` 相等

#### Scenario: surface 重写后新对象获得新证明

- **WHEN** surface `replace` 使派生缓存重建并产生新的消息对象
- **THEN** 新对象 SHALL NOT 命中既有证明集合
- **AND** SHALL 在首次进入请求时被深冻结
