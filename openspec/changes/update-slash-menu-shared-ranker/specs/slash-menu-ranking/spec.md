# slash-menu-ranking 规范增量

## ADDED Requirements

### Requirement: 斜杠菜单候选由共享排序器排名

`/` 菜单的所有候选源 SHALL 使用 `packages/client/ui-primitives` 导出的 `rankByName` 排序。命令候选源与 skill 候选源 SHALL NOT 各自实现匹配或排序。

`rankByName` SHALL 按不区分大小写的有序子序列匹配候选名称；查询为空时 SHALL 返回输入数组本身。

#### Scenario: 子序列查询命中候选

- **WHEN** 用户在 `/` 菜单输入一个不作为前缀出现的字符子序列
- **THEN** 名称包含该有序子序列的候选 SHALL 出现在结果中
- **AND** 名称不包含该子序列的候选 SHALL 被排除

#### Scenario: 前缀命中排在前

- **WHEN** 两个候选都匹配查询，其中一个的名称以查询为前缀
- **THEN** 名称以查询为前缀的候选 SHALL 排在前面
- **AND** 其余匹配 SHALL 按对齐得分排序
- **AND** 得分相同的候选 SHALL 保持源序

#### Scenario: 空查询不重排

- **WHEN** 用户未输入任何查询字符
- **THEN** 候选列表 SHALL 按源序返回
- **AND** 返回的数组 SHALL 与输入数组相同

#### Scenario: 命令与 skill 候选使用同一规则

- **WHEN** 用户在 `/` 菜单输入同一查询
- **THEN** 命令候选与 skill 候选 SHALL 使用同一套匹配与排序规则
- **AND** SHALL NOT 出现某一源只做前缀匹配的情况

### Requirement: 候选标题参与匹配

候选的本地化标题 SHALL 作为名称之外的第二搜索键。任一键命中即视为匹配，得分取两键中的较高者。

#### Scenario: 按标题子序列命中候选

- **WHEN** 用户输入某候选本地化标题的子序列，而该子序列不出现在候选名称中
- **THEN** 该候选 SHALL 出现在结果中

#### Scenario: 标题前缀命中与名称前缀命中同权

- **WHEN** 一个候选的名称以查询为前缀，另一个候选的标题以查询为前缀
- **THEN** 两者 SHALL 都被视为前缀命中

### Requirement: 子 agent 会话不提供 skill 候选

skill 候选源 SHALL 在其会话为子 agent 会话时返回空列表。

#### Scenario: 子 agent 会话没有 skill 候选

- **WHEN** `/` 菜单的 skill 候选源被一个子 agent 会话调用
- **THEN** 它 SHALL 返回空列表
- **AND** SHALL NOT 请求该会话的 skill 目录
