## MODIFIED Requirements

### Requirement: 信号词表的命中判定对用户可见

强、中、弱信号词表 SHALL 以可逐条增删的标签形式编辑，每条可独立添加与删除。每个词表字段的说明 SHALL 陈述：匹配忽略大小写、按子串包含判定、每条命中计 1 次、可填任意中英文字符串、以及新增一条即多一个判定词。说明 SHALL 解释默认词表中的英语词干（如 `replac`）是刻意写法而非拼写错误，并提示用户新增时避免让一条包含另一条。

#### Scenario: 标签式逐条增删
- **WHEN** 用户展开交付纪律卡片并查看任一信号词表
- **THEN** 每个值 SHALL 渲染为一个可删除的标签，且 SHALL 提供一个输入框用于添加新标签

#### Scenario: 说明陈述匹配规则与取值
- **WHEN** 用户查看任一信号词表字段的说明
- **THEN** 说明 SHALL 写明忽略大小写、子串包含、每条计 1 次、可填任意中英文文本，以及含 3 条及以上编号项的需求额外计 1 个中等信号

#### Scenario: 词干写法得到解释
- **WHEN** 用户查看中等信号字段的说明
- **THEN** 说明 SHALL 指出内置词表使用英语词干以一条覆盖整个词族并只计一次，且 SHALL 提示新增条目时避免互相包含

### Requirement: 验收命令从提示词命令中勾选

交付纪律的验收命令 SHALL 由用户从「提示词命令」页已配置的命令中勾选，SHALL NOT 要求用户手写 shell 命令。该配置 SHALL 由 `delivery` 命名空间的 `verificationCommands` 承载，取值为提示词命令名且不含前导斜杠；旧 `postHooks` 字段 SHALL 被忽略且不提供回退。

#### Scenario: 勾选已配置的提示词命令
- **WHEN** 「提示词命令」页存在已配置命令
- **THEN** 交付纪律卡片 SHALL 以复选框列出这些命令，勾选结果 SHALL 写入 `verificationCommands`

#### Scenario: 无候选命令时给出空态
- **WHEN** 「提示词命令」页没有配置任何命令
- **THEN** 卡片 SHALL 展示引导用户先到该页添加命令的空态说明，且不阻塞保存其它字段

### Requirement: 提示词验收留下记录才放行

勾选了验收命令的交付任务 SHALL NOT 在未留下该任务验收记录时推进到「已验证」。阻止推进时，门禁消息 SHALL 包含每条勾选命令的提示词文本，并要求模型执行后以 `record_change` 记录验收结果。留下验收记录后 SHALL 放行。

#### Scenario: 未留下验收记录时阻止推进
- **WHEN** 任务已勾选验收命令，模型在未留下验收记录时推进到「已验证」
- **THEN** 系统 SHALL 阻止推进，且门禁消息 SHALL 含所勾选命令的提示词与「执行后调用 record_change 记录验收结果」的要求

#### Scenario: 留下验收记录后放行
- **WHEN** 任务已勾选验收命令，模型已为该任务留下验收记录
- **THEN** 系统 SHALL 允许推进到「已验证」

### Requirement: L2 结构校验不随验收命令变更而丢失

`l2` 交付任务在推进到「已验证」时 SHALL 仍由 Host 执行 `openspec validate <changeId> --strict --json` 并按退出码判定，该判定 SHALL NOT 因验收命令改为提示词而移除或降级。

#### Scenario: L2 仍执行结构校验
- **WHEN** `l2` 任务推进到「已验证」
- **THEN** 系统 SHALL 在提示词验收之前执行 `openspec validate <changeId> --strict --json`，非零退出 SHALL 阻止验证

#### Scenario: 结构校验不受验收命令配置影响
- **WHEN** 部署未勾选任何验收命令
- **THEN** `l2` 任务 SHALL 仍执行 `openspec validate <changeId> --strict --json`

## ADDED Requirements

### Requirement: 交付纪律卡片不再渲染游离字符

交付纪律卡片 SHALL NOT 渲染不属于任何字段或文案的游离文本节点。

#### Scenario: 卡片底部无游离字符
- **WHEN** 用户展开交付纪律卡片
- **THEN** 卡片内容 SHALL NOT 包含裸 `)` 文本

### Requirement: 帮助入口紧随卡片描述

交付纪律卡片的帮助入口 SHALL 与卡片描述文案位于同一行，紧随描述文本之后，SHALL NOT 单独占一行。

#### Scenario: 帮助链接与描述同行
- **WHEN** 用户展开交付纪律卡片
- **THEN** 卡片描述文案与帮助链接 SHALL 渲染在同一行，且帮助链接 SHALL 仍可点击打开参考对话框

### Requirement: 交付纪律字段分两列排布

交付纪律卡片的短控件（枚举、开关、数字阈值）SHALL 每行排布两个；多行输入与标签编辑控件 SHALL 整行占满；窄视口 SHALL 回落为单列。

#### Scenario: 短控件两列
- **WHEN** 用户在足够宽的视口展开交付纪律卡片
- **THEN** 相邻两个短控件 SHALL 位于同一行

#### Scenario: 长控件整行
- **WHEN** 卡片渲染标签式信号词表或验收命令控件
- **THEN** 该控件 SHALL 占据整行宽度
