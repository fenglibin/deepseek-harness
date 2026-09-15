# coverage-reporting 规范增量

## ADDED Requirements

### Requirement: 分区覆盖率合并归属正确

覆盖率分区模式 SHALL 在 blob 序列化之前规范化位置数据，使同一语句在不同环境的拼写拥有相同的键。跨到行尾的语句结束列 SHALL 以有限值表示。

规范化 SHALL 在 reporter 的 `onCoverage` 钩子执行，即 Vitest 交付完成运行的覆盖率 map 之后、blob reporter 序列化之前。

#### Scenario: 幽灵未覆盖语句不再出现

- **WHEN** 一个分区内某语句仅在 client 拼写中被 v8 记为跨到行尾
- **THEN** 该语句 SHALL 在合并后的覆盖率中记为已覆盖
- **AND** SHALL NOT 残留为未覆盖语句

#### Scenario: 载荷形状变化时失败而非静默

- **WHEN** `onCoverage` 收到的载荷不含 istanbul 的 `data` 记录
- **THEN** 规范化 SHALL 抛出错误
- **AND** 该分区 SHALL 失败而不是留下未规范化的位置

#### Scenario: 与未覆盖位置打印共存

- **WHEN** 一次分区覆盖率运行同时启用位置规范化与未覆盖位置打印
- **THEN** 两者 SHALL 都生效
- **AND** 未覆盖位置 SHALL 仍以可点击的 `path:line:col` 形式输出
- **AND** 规范化写入的哨兵列 SHALL NOT 被打印为实际列号

#### Scenario: 规范化只在分区内生效

- **WHEN** 一次未分区的覆盖率运行完成
- **THEN** 其覆盖率位置 SHALL 保持未规范化
- **AND** 其报告 SHALL 与本次变更前一致

### Requirement: 测试进程不受宿主代理影响

测试进程 SHALL 在启动时清除代理环境变量，使测试结果不由开发机上的代理配置决定。

#### Scenario: 宿主代理不影响测试

- **WHEN** 宿主机设置了 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 或 `NO_PROXY`
- **THEN** 测试进程 SHALL 在这些变量被清除的状态下运行
- **AND** 测试结果 SHALL 与未设置代理时一致

#### Scenario: 大小写变体一并清除

- **WHEN** 宿主机以小写形式设置代理变量
- **THEN** 这些变量 SHALL 同样被清除

#### Scenario: 只清除实际设置的变量

- **WHEN** 清除在一个只有部分代理变量存在的环境上执行
- **THEN** 它 SHALL 只报告实际携带值的名字
- **AND** SHALL NOT 改动其他环境变量

#### Scenario: 声明 setup 的配置都接入清理

- **WHEN** 枚举仓库中的 Vitest 配置
- **THEN** 每个声明了 `setupFiles` 的配置 SHALL 都把本清理文件列为 setup 项
- **AND** 未声明 `setupFiles` 的配置 SHALL 被忽略
