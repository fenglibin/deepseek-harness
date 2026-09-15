# experimental-release 规范增量

## ADDED Requirements

### Requirement: 实验包发布策略有单一真相源

实验包是否对外发布 SHALL 由 `scripts/experimental-package-policy.ts` 导出的判定函数决定。发布成员发现、工作区约束校验与 npm baseline 相关脚本 SHALL 从该函数读取，SHALL NOT 各自内联目录判断。

判定函数 SHALL 接受仓库相对目录与私有目录清单，并 SHALL 对非实验包目录返回 `false`。

#### Scenario: 私有实验包不进入发布成员

- **WHEN** 一个实验包目录出现在私有清单中
- **THEN** 发布成员发现 SHALL 排除该目录
- **AND** 该包 SHALL NOT 出现在发布的成员集合中

#### Scenario: 非实验包目录一律不公开

- **WHEN** 判定函数收到形如 `packages/mcp/mcp-manager` 的非实验包目录
- **THEN** 它 SHALL 返回 `false`

#### Scenario: 调用方可以注入自己的清单

- **WHEN** 调用方传入自定义的私有目录清单
- **THEN** 判定 SHALL 按该清单进行
- **AND** SHALL NOT 读取默认清单

### Requirement: 命名约定与发布策略保持正交

实验包的 `name` 前缀校验 SHALL 继续由 `scripts/check-workspace-constraints.ts` 独立强制。本策略 SHALL NOT 承担命名校验职责。

#### Scenario: 缺少前缀的实验包仍被拒绝

- **WHEN** 一个 `packages/experimental/*` 包的 `name` 不带 `@deepseek-ai/dsh-experimental-` 前缀
- **THEN** 工作区约束校验 SHALL 报告违规
- **AND** 该报告 SHALL NOT 受发布策略影响

### Requirement: 变更不改变实际发布的包集合

本次重构 SHALL NOT 改变任何包的 `private` 字段，也 SHALL NOT 改变发布的成员集合。

#### Scenario: 发布成员集合保持不变

- **WHEN** 在同一提交前后各运行一次发布成员发现
- **THEN** 两次得到的成员集合 SHALL 完全相同

#### Scenario: 实验包的 private 字段不变

- **WHEN** 检查任一 `packages/experimental/*/package.json`
- **THEN** 其 `private` 字段 SHALL 与本次变更前一致
